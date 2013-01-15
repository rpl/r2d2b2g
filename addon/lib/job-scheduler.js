/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

// # job-scheduler module

// This module exports:
//
// * JobScheduler class (used to enqueue and process jobs)
// * Job class (used to instance a job object from a job definition),
//   associated to a list of steps
// * JobStep class, composed by run and cleanup method definitions
// * ComposedJobStep class, used to define composed steps and associate
//   an optional timeout and/or max retries

const { Class } = require("sdk/core/heritage");
const { ns } = require("sdk/core/namespace");
const { EventTarget } = require("sdk/event/target");
const { emit,off } = require("sdk/event/core");
const { defer, promised } = require('sdk/core/promise');
const { setTimeout, clearTimeout } = require('sdk/timers');
const UUID = require("sdk/util/uuid");

const nsSched = ns();

let DEBUG = false;

function debug() {
  if (DEBUG)
    console.debug.apply(console, arguments);
}

// # JobScheduler
//
// Example
// <pre><code>
//   let ds = simulator.definedSteps;
//   let js = JobScheduler({state: {simulator: simulator};
//   js.on("error", function (data) { let {error, errorStepIndex, step} = data; ... };
//   js.on("progress", function (data) { let {percent, step} = data; ... };
//   js.on("completed", function (data) { let {success, error, ...} = data; ... };
//   ...
//   let job = js.enqueueJob({
//     steps: [
//       ds.Ready(),
//       ds.LockScreen({enabled: false}),
//       ds.MiniMarketServer({enabled: true}),
//       ds.RegeneratePackagedApp({appId: appId}),
//       ds.InstallPackagedApp({appId: appId}),
//       ds.updateRegisteredAppStatus({appId: appId})
//     ]
//   });
//   ...
//   js.processQueue();
// </code></pre>
const JobScheduler = Class({
  extends: EventTarget,

  initialize: function initialize(options) {
    let priv = nsSched(this);
    priv.queue = []
    priv.state = options.state || {};
    EventTarget.prototype.initialize.call(this, options);
  },

  enqueueJob: function(jobConfig) {
    let deferred = defer();
    let priv = nsSched(this);
    let job = null;
    if (jobConfig.steps) {
      job = CompositeJob(jobConfig);
    } else {
      job = Job(jobConfig);
    }
    nsSched(job).jobId = this._generateJobId();

    if (jobConfig.failOnBusy && this.isBusy) {
      return null;
    }

    priv.queue.push(job);

    emit(this,"pushed", job);

    return job;
  },

  processQueue: function () {
    let priv = nsSched(this);

    let job = priv.queue.shift();

    if(job) {
      console.log("Processing queue: ",job.toString());
      job.on("progress", (function(progress) {
        emit(this,"progress", {
          job: job,
          progress: progress
        });
      }).bind(this));
      job.run(priv.state).then((function() {
        emit(this,"completed", job);
      }).bind(this));
    }
  },

  get isBusy() {
    let priv = nsSched(this);

    return priv.queue.length > 0;
  },

  _generateJobId: function(app) {
    return UUID.uuid();
  },

});

exports.JobScheduler = JobScheduler;

// # Job
//
// A Job handle run an operation, cancel a pending operation (on timeout/retries
// or on abort) and optionally cleanup (explicit or before exit)
const Job = Class({
  // ## EventTarget
  // private use
  extends: EventTarget,

  // ## name
  name: "JobUnknown",

  // ## methods to be implemented by subclasses
  // ### handleRun
  handleRun: function(ctx, deferred) {
    // do nothing
    deferred.resolve();
  },
  // ### handleCancel
  handleCancel: function(ctx, deferred) {
    // do nothing
    deferred.resolve();
  },
  // ### handleCleanup
  handleCleanup: function(ctx, deferred) {
    // do nothing
    deferred.resolve();
  },  

// ## public API
  // ### run
  run: function(ctx, autoCleanup) {
    let d = defer();
    emit(this, "Job:fsm", {
      type: "run",
      ctx: ctx,
      autoCleanup: typeof autoCleanup === "undefined" ? true : autoCleanup,
      userDeferred: d,
    });
    return d.promise;
  },
  // ### abort
  abort: function(reason) {
    let d = defer();
    emit(this, "Job:fsm", {
      type: "abort",
      reason: reason,
      userDeferred: d,
    });
    return d.promise;
  },
  // ### cleanup
  cleanup: function() {
    let d = defer();
    emit(this, "Job:fsm", {
      type: "cleanup",
      userDeferred: d,
    });
    return d.promise;
  },

  // ### success
  get success() {
    let priv = nsSched(this);
    return priv.success;
  },
  // ### error
  get error() {
    let priv = nsSched(this);
    return priv.error;
  },
  // ### isAbort
  get isAbort() {
    let priv = nsSched(this);
    return !!priv.abort;
  },
  // ### isAbort
  get abortReason() {
    let priv = nsSched(this);
    return priv.abort;
  },
  // ### toString
  toString: function() {
    let priv = nsSched(this);
    return this.name + ":" + JSON.stringify(priv.options);
  },

// ## Internals
  // ### successCancel
  get successCancel() {
    let priv = nsSched(this);
    return priv.successCancel;
  },
  // ### errorCancel
  get errorCancel() {
    let priv = nsSched(this);
    return priv.errorCancel;
  },
  // ### successCleanup
  get successCleanup() {
    let priv = nsSched(this);
    return priv.successCleanup;
  },
  // ### errorCleanup
  get errorCleanup() {
    let priv = nsSched(this);
    return priv.errorCleanup;
  },
  // ### initialize
  initialize: function(options) {
    EventTarget.prototype.initialize.call(this, options);

    let priv = nsSched(this);
    priv.userDeferred = [];
    priv.options = options || {};
    priv.retries = priv.retries || priv.options.maxRetries || 1;
    priv.state = "NEW";
    this.on("Job:fsm", this._handleFSMEvent.bind(this));
  },
  _warn: function() {
    if (!this.disableWarn)
      console.warn.apply(console,arguments);
  },
  // ### handleFSMEvent
  _handleFSMEvent: function(req) {
    let priv = nsSched(this);
    debug(this.name+": handle Job:fsm ", req.type, priv.state);
    switch(priv.state) {
    case "NEW":
      this._handleOnNewState(req);
      break;
    case "RUN":
      this._handleOnRunState(req);
      break;
    case "CANCEL":
      this._handleOnCancelState(req);
      break;
    case "CLEANUP":
      this._handleOnCleanupState(req);
      break;
    case "COMPLETED":
      this._handleOnCompletedState(req);
      break;
    }
  },
  // ### handleOnNewState
  _handleOnNewState: function(req) {
    let priv = nsSched(this);

    if (req.type === "run") {
      priv.userDeferred.push(req.userDeferred);
      this._goRun(req);
    } else if (req.userDeferred) {
        req.userDeferred.reject(Error("invalid request"));
    }
  },
  // ### handleOnRunState
  _handleOnRunState: function(req) {
    let priv = nsSched(this);

    switch (req.type) {
    case "enterRun":
      if (priv.retries > 0) {
        priv.ctx = req.ctx;
        priv.runRequest = req;
        priv.autoCleanup = req.autoCleanup;
        this._startTimeout();
        this._doRun();
      } else {
        emit(this, "Job:fsm", {
          type: "abort",
          reason: "max retries already reached"
        });
      }
      break;
    case "timeout":
      this._goCancel(req);
      break;
    case "abort":
      priv.success = false;
      priv.error = Error("aborted");
      priv.abort = req.reason;
      if (req.userDeferred)
        priv.userDeferred.push(req.userDeferred);
      this._clearTimeout();
      priv.retries = 0;
      this._goCancel();
      break;
    case "retry":
      if (priv.retries > 1) {
        priv.retries--;
        emit(this, "Job:fsm", priv.runRequest);
      } else {
        priv.success = false;
        priv.error = Error("max retries reached");
        if (priv.autoCleanup) {
          this._goCleanup();
        } else {
          this._doExit();
        }
      }
      break;
    case "exitRun":
      priv.success = req.success;
      priv.error = req.error;
      if (priv.autoCleanup)
        this._goCleanup(req);
      else
        this._doExit();
      break;
    default:
      if (req.userDeferred)
        req.userDeferred.reject(Error("invalid Job:fsm"));
    }
  },
  // ### handleOnCancelState
  _handleOnCancelState: function(req) {
    let priv = nsSched(this);

    switch(req.type) {
    case "enterCancel":
      this._startTimeout();
      this._doCancel();
      break;
    case "abort":
      // NOTE: it's safe to abort during the cancel state
      priv.abort = req.reason;
      if (req.userDeferred)
        priv.userDeferred.push(req.userDeferred);
      this._clearTimeout();
      this._doAbort();
      break;
    case "timeout":
      this._warn(this.name+": timeout during cancel");
      this._doAbort();
      break;
    case "exitCancel":
      if (!req.success)
        this._warn(this.name+": error during cancel",req.error);
      this._doRetry();
      break;
    default:
      if (req.userDeferred)
        req.userDeferred.reject(Error("invalid Job:fsm"));
    }
  },

  // ### handleOnCleanupState
  _handleOnCleanupState: function(req) {
    let priv = nsSched(this);

    switch(req.type) {
    case "enterCleanup":
      this._startTimeout();
      this._doCleanup();
      break;
    case "abort":
      // NOTE: it's safe to abort during the cleanup state
      priv.abort = req.reason;
      if (req.userDeferred)
        priv.userDeferred.push(req.userDeferred);
      this._clearTimeout();
      this._doExit();
      break;
    case "timeout":
      this._warn(this.name+": timeout during cleanup");
      this._doExit();
      break;
    case "exitCleanup":
      if (!req.success)
        this._warn(this.name+": error during cleanup",req.error);
      this._doExit();
      break;
    default:
      if (req.userDeferred)
        req.userDeferred.reject(Error("invalid Job:fsm"));
    }
  },
  // ### handleOnCompletedState
  _handleOnCompletedState: function(req) {
    let priv = nsSched(this);

    switch(req.type) {
    case "cleanup":
      if (!priv.autoCleanup && !priv.successCleanup) {
        priv.userDeferred.push(req.userDeferred);
        this._goCleanup();
      } else {
        req.userDeferred.reject(Error("invalid Job:fsm"));
      }
      break;
    case "exitCleanup":
      if (!req.success)
        this._warn(this.name+": error during cleanup",req.error);
      this._doExit();
    default:
      if (req.userDeferred)
        req.userDeferred.reject(Error("invalid Job:fsm"));
    }
  },

  // ### goRun
  _goRun: function(req) {
    let priv = nsSched(this);
    priv.state = "RUN";
    emit(this, "Job:fsm", {type: "enterRun", ctx: req.ctx, 
                           autoCleanup: req.autoCleanup});
  },
  // ### goCancel
  _goCancel: function(req) {
    let priv = nsSched(this);
    priv.state = "CANCEL";
    emit(this, "Job:fsm", {type: "enterCancel", req: req});
  },
  // ### goCleanup
  _goCleanup: function(req) {
    let priv = nsSched(this);
    priv.state = "CLEANUP";
    emit(this, "Job:fsm", {type: "enterCleanup", req: req});
  },

  // ### startTimeout
  _startTimeout: function() {
    let job = this;
    let priv = nsSched(this);

    if (priv.options && priv.options.timeout) {
      priv.runningTimeout = setTimeout(function() {
        delete priv.runningTimeout;
        emit(job, "Job:fsm", {
          type: "timeout"
        });
      }, priv.options.timeout);
    }
  },
  // ### clearTimeout
  _clearTimeout: function() {
    let priv = nsSched(this);

    if (priv.runningTimeout) {
      clearTimeout(priv.runningTimeout);
      delete priv.runningTimeout;
    }
  },
 
  // ### doRun
  _doRun: function() {
    let job = this;
    let priv = nsSched(this);
    try {
      let d = priv.currentDefer = defer();
      job.handleRun(priv.ctx, d);
      d.promise.then(function resolved() {
        job._clearTimeout();
        emit(job, "Job:fsm", {
          type: "exitRun",
          success: true
        });
      }, function rejected(e) {
        job._clearTimeout();
        emit(job, "Job:fsm", {
          type: "exitRun",
          success: false,
          error: e
        });
      });
    } catch(e) {
      job._clearTimeout();
      emit(job, "Job:fsm", {
        type: "exitRun",
        success: false,
        error: e
      });
    }
  },
  // ### doCancel
  _doCancel: function() {
    let job = this;
    let priv = nsSched(this);
    try {
      let d = priv.currentDefer = defer();
      job.handleCancel(priv.ctx, d);
      d.promise.then(function resolved() {
        job._clearTimeout();
        priv.successCancel = true;
        emit(job, "Job:fsm", {
          type: "exitCancel",
          success: true
        });
      }, function rejected(e) {
        job._clearTimeout();
        priv.successCancel = false;
        priv.errorCancel = e;
        emit(job, "Job:fsm", {
          type: "exitCancel",
          success: false,
          error: e
        });
      });
    } catch(e) {
      job._clearTimeout();
      priv.successCancel = false;
      priv.errorCancel = e;
      emit(job, "Job:fsm", {
        type: "exitCancel",
        success: false,
        error: e
      });
    }
  },
  // ### doRetry
  _doRetry: function() {
    let priv = nsSched(this);
    priv.state = "RUN";
    emit(this, "Job:fsm", {
      type: "retry"
    });
  },
  // ### doAbort
  _doAbort: function() {
    let priv = nsSched(this);
    priv.state = "RUN";
    priv.retries = 0;
    emit(this, "Job:fsm", {
      type: "retry"
    });    
  },
  // ### doCleanup
  _doCleanup: function() {
    let job = this;
    let priv = nsSched(this);
    try {
      let d = priv.currentDefer = defer();
      job.handleCleanup(priv.ctx, d);
      d.promise.then(function resolved() {
        job._clearTimeout();
        priv.successCleanup = true;
        emit(job, "Job:fsm", {
          type: "exitCleanup",
          success: true
        });
      }, function rejected(e) {
        job._clearTimeout();
        priv.successCleanup = false;
        priv.errorCleanup = e;
        emit(job, "Job:fsm", {
          type: "exitCleanup",
          success: false,
          error: e
        });
      });
    } catch(e) {
      job._clearTimeout();
      priv.successCleanup = false;
      priv.errorCleanup = e;
      emit(job, "Job:fsm", {
        type: "exitCleanup",
        success: false,
        error: e
      });
    }
  },
  // ### doExit
  _doExit: function() {
    let priv = nsSched(this);
    priv.state = "COMPLETED";
    while (priv.userDeferred.length > 0) {
      priv.userDeferred.shift().resolve();
    }
  }
});

exports.Job = Job;

// # CompositeJob
//
// A CompositeJob extends Job and runs an array of Job instances,
// and cleanup them in reverse order.
const CompositeJob = Class({
  name: "CompositeJobUnknown",
  extends: Job,
  initialize: function(options) {
    Job.prototype.initialize.call(this, options);
    let priv = nsSched(this);
    priv.currentStepIndex = 0;
    priv.steps = options.steps;
    priv.totalSteps = priv.steps.length;
    priv.runList = priv.steps.map(function(step) {
      return function run(ctx) {
        debug("CompositeJob running:",step);
        // NOTE: disable autoCleanup on exit for multistep job
        return step.run(ctx, false); 
      }
    });
    priv.cleanupList = priv.steps.map(function(step) {
      return function cleanup() {
        debug("CompositeJob cleanup:",step);
        // NOTE: explicit cleanup
        return step.cleanup();
      }
    });
    this.on("CompositeJob:fsm", this._handleComposedFSMEvent.bind(this));
  },
  handleRun: function(ctx, deferred) {
    emit(this, "CompositeJob:fsm", {
      type: "doRun",
      ctx: ctx,
      deferred: deferred
    });
  },
  handleCancel: function(ctx, deferred) {
    emit(this, "CompositeJob:fsm", {
      type: "doCancel",
      ctx: ctx,
      deferred: deferred
    });
  },
  handleCleanup: function(ctx, deferred) {
    let priv = nsSched(this);
    emit(this, "CompositeJob:fsm", {
      type: "doCleanup",
      ctx: ctx,
      deferred: deferred,
      stepIndex: priv.currentStepIndex
    });
  },
  _handleComposedFSMEvent: function(req) {
    let priv = nsSched(this);
    debug(this.name+": handleComposedFSMEvent ", req.type, priv.state);
    priv.ctx = req.ctx;
    switch(priv.state) {
    case "RUN":
      this._handleComposedOnRunState(req);
      break;
    case "CANCEL":
      this._handleComposedOnCancelState(req);
      break;
    case "CLEANUP":
      this._handleComposedOnCleanupState(req);
      break;
    }
  },
  _handleComposedOnRunState: function(req) {
    let job = this;
    let priv = nsSched(this);
    switch(req.type) {
    case "doRun":
      if (priv.currentStepIndex < priv.totalSteps) {
        let runStep = priv.runList[priv.currentStepIndex];
        let jobStep = priv.steps[priv.currentStepIndex];
        runStep(priv.ctx).then(function () {
          priv.progress = {
            index: priv.currentStepIndex,
            total: priv.totalSteps,
            success: jobStep.success,
            error: jobStep.error 
          };
          emit(job, "progress", priv.progress);

          if (jobStep.success) {
            priv.currentStepIndex++;
            emit(job, "CompositeJob:fsm", {
              type: "doRun",
              ctx: req.ctx,
              deferred: req.deferred
            });
          } else {
            req.deferred.reject(jobStep.error)
          }
        });
      } else {
        priv.currentStepIndex = priv.totalSteps-1;
        req.deferred.resolve();
      }
      break;
    default:
      req.deferred.reject(Error("invalid CompositeJob:fsm"));
    }
  },
  _handleComposedOnCancelState: function(req) {
    let job = this;
    let priv = nsSched(this);
    switch(req.type) {
    case "doCancel":
      let jobStep = priv.steps[priv.currentStepIndex];
      // cancel running step if any
      // TODO: check if jobStep is defined
      jobStep.abort("CompositeJob Cancel").then(function () {
        priv.currentStepIndex--;
        job.abort("CompositeJob cancel");
      });
      break;
    default:
      req.deferred.reject(Error("invalid CompositeJob:fsm"));
    }
  },
  _handleComposedOnCleanupState: function(req) {
    let job = this;
    let priv = nsSched(this);
    switch(req.type) {
    case "doCleanup":
      if (priv.currentStepIndex >= 0) {
        let cleanStep = priv.cleanupList[priv.currentStepIndex];
        let jobStep = priv.steps[priv.currentStepIndex];
        cleanStep().then(function () {
          priv.progress = {
            index: priv.currentStepIndex,
            total: priv.totalSteps,
            success: jobStep.successCleanup,
            error: jobStep.errorCleanup 
          };
          emit(job, "cleanupProgress", priv.progress);

          if (jobStep.successCleanup) {
            priv.currentStepIndex--;
            emit(job, "CompositeJob:fsm", {
              type: "doCleanup",
              ctx: req.ctx,
              deferred: req.deferred
            });
          } else {
            req.deferred.reject(jobStep.errorCleanup)
          }
        });
      } else {
        req.deferred.resolve();
      }
      break;
    default:
      req.deferred.reject(Error("invalid CompositeJob:fsm"));
    }
  },
});

exports.CompositeJob = CompositeJob;

