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

// ## JobScheduler
//
// Example
// <pre><code>
//   let ds = simulator.definedSteps;
//   let jobScheduler = JobScheduler({state: {simulator: simulator};
//   ...
//   let job = jobScheduler.enqueueJob({
//     steps: [
//       ds.Ready(),
//       ds.LockScreen({enabled: false}),
//       ds.MiniMarketServer({enabled: true}),
//       ds.RegeneratePackagedApp({appId: appId}),
//       ds.InstallPackagedApp({appId: appId}),
//       ds.updateRegisteredAppStatus({appId: appId})
//     ]
//   });
//   job.on("error", function (data) { let {error, errorStepIndex, step} = data; ... };
//   job.on("progress", function (data) { let {percent, step} = data; ... };
//   job.on("completed", function (data) { let {success, error, ...} = data; ... };
//   ...
//   jobScheduler.processQueue();
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
    let job = Job(jobConfig);
    nsSched(job).jobId = this._generateJobId();

    if (jobConfig.failOnBusy && this.isBusy)
      return null;

    JobPrivateAPI.init(job, priv.state);

    priv.queue.push(job);

    emit(this,"pushed", job);

    return job;
  },

  processQueue: function () {
    let priv = nsSched(this);

    let job = priv.queue.shift();

    if(job) {
      console.log("Processing queue: ",job.toString());
      job.once("completed", (function () {
        emit(this,"completed", job);
      }).bind(this));
      JobPrivateAPI.run(job);
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

// ## JobStep

// RunApp = Class({
//   extends: JobStep,
//   run: function (state,deferred) {
//     ...
//   },
//   cleanup: function (state,deferred) {
//     ...
//   },
// });
const JobStep = Class({
  name: "dumb",
  retry: null,
  timeout: null,
  initialize: function(options) {
    // TODO: validate options and required attributes
  },
  run: function(state, deferred) {},
  cleanup: function(state, deferred) {},
  toString: function() {
    return "JobStep["+this.name+"]";
  }
});

let JobStepPrivateAPI = nsSched(JobStep);
JobStepPrivateAPI.run = function(step,state) {
  let priv = nsSched(step);
  let deferred = priv.deferred = defer();

  try {
    step.run(state, deferred);
  } catch(e) {
    deferred.reject(e);
  }

  return deferred.promise;
};
JobStepPrivateAPI.cleanup = function(step,state) {
  let priv = nsSched(step);
  let deferred = priv.deferred = defer();

  step.cleanup(state, deferred);

  return deferred.promise;
};

// ## Job

const Job = Class({
  extends: EventTarget,

  initialize: function initialize(options) {
    this.steps = options.steps || [];
    EventTarget.prototype.initialize.call(this, options);
  },
  toString: function() {
    let priv = nsSched(this);
    return "Job["+priv.jobId+"] steps: "+this.steps.join(",");
  }
});

let JobPrivateAPI = nsSched(Job);
JobPrivateAPI.reportError = function(job) {
  console.debug("JobPrivateAPI.reportError");
  let priv = nsSched(job);
  emit(job,"error",{
    error: priv.error,
    errorStepIndex: priv.errorStepIndex,
    step: job.steps[priv.errorStepIndex].toString(),
  });
};
JobPrivateAPI.reportProgress = function(job) {
  console.debug("JobPrivateAPI.reportProgress");
  let priv = nsSched(job);
  emit(job,"progress",{
    percent: priv.currentStepIndex/priv.runList.length,
    step: job.steps[priv.currentStepIndex],
  });
};
JobPrivateAPI.reportCleanupProgress = function(job) {
  console.debug("JobPrivateAPI.reportCleanupProgress");
  let priv = nsSched(job);
  emit(job,"cleanupProgress",{
    percent: 1-priv.currentStepIndex/priv.errorStepIndex,
    step: job.steps[priv.currentStepIndex],
  });
};
JobPrivateAPI.reportCompleted = function(job) {
  console.debug("JobPrivateAPI.reportCompleted");
  let priv = nsSched(job);
  priv.success = priv.error ? false : true;
  emit(job,"completed",priv);
};
JobPrivateAPI.init = function(job,state) {
  let priv = nsSched(job);
  priv.state = state || {};
  priv.currentStepIndex = 0;
  priv.runList = job.steps.map(function(step) {
    return function run(cleanupMode) {
      console.debug("running ",step);
      if (cleanupMode) {
        return JobStepPrivateAPI.cleanup(step,state);
      } else {
        return JobStepPrivateAPI.run(step,state);
      }
    }
  });
};
JobPrivateAPI.run = function(job) {
  console.debug("JobPrivateAPI.run");
  let priv = nsSched(job);
  let state = priv.state;
  let deferred = priv.deferred = defer();
  let currentStepIndex = priv.currentStepIndex;

  let runList = priv.runList;

  if (currentStepIndex < runList.length) {
    let currentStep = runList[currentStepIndex];
    if (!currentStep) {
      console.error("invalid step", JSON.stringify(priv));
    }
    currentStep().
      then(function resolved() {
        JobPrivateAPI.reportProgress(job);
        priv.currentStepIndex++;
        JobPrivateAPI.run(job);
      }, function rejected(error) {
        priv.error = error;
        priv.errorStepIndex = priv.currentStepIndex;
        JobPrivateAPI.reportError(job);
        JobPrivateAPI.cleanup(job);
      });
  } else {
    priv.currentStepIndex = runList.length-1;
    JobPrivateAPI.cleanup(job);
  }

  return deferred.promise;
};

JobPrivateAPI.cancel = function(job, reason) {
  console.debug("JobPrivateAPI.cancel");
  let priv = nsSched(job);
  let step = job.steps[priv.currentStepIndex];
  nsSched(step).deferred.reject("cancelled: "+step.toString()+","+reason);
};

JobPrivateAPI.cleanup = function(job) {
  console.debug("JobPrivateAPI.cleanup");
  let priv = nsSched(job);
  let deferred = priv.deferred = defer();
  let currentStepIndex = priv.currentStepIndex;
  let runList = priv.runList;

  if (currentStepIndex >= 0) {
    let runStep = runList[currentStepIndex];
    runStep(true).
      then(function resolved() {
        JobPrivateAPI.reportCleanupProgress(job);
        priv.currentStepIndex--;
        JobPrivateAPI.cleanup(job);
      }, function rejected(error) {
        priv.error = error;
        JobPrivateAPI.reportError(job);
        priv.currentStepIndex--;
        JobPrivateAPI.cleanup(job);
      });
  } else {
    JobPrivateAPI.reportCompleted(job);
  }

  return deferred.promise;
}

const ComposedJobStep = Class({
  name: "ComposedJobStep",
  extends: JobStep,

  initialize: function(options) {
    this.maxRetries = options.maxRetries;
    this.timeout = options.timeout;
    this.job = Job({
      steps: options.steps
    });
  },
  run: function(state, deferred) {
    let step = this;
    let job = this.job;
    let startTimeout = function() {
      step._tid = setTimeout(function () {
        JobPrivateAPI.cancel(job, "timeout");
      } , this.timeout);
    };
    this.job.on("completed", function (data) {
      console.debug("job completed", JSON.stringify(data));
      clearTimeout(step._tid);
      if(data.success) {
        deferred.resolve();
      } else {
        if (step.maxRetries > 0) {
          step.retries = step.retries || 1;

          if (step.retries < step.maxRetries) {
            console.debug(step.name, "fail", data.error.toString());
            console.debug(step.name, "retries", step.retries);
            let priv = nsSched(job);
            priv.currentStepIndex = 0;
            startTimeout();
            step.retries++;
            JobPrivateAPI.run(job);
          } else {
            console.debug(step.name, "max retries reached", step.maxRetries);
            deferred.reject("max retries reached");
          }
        } else {
          deferred.reject(data.error);
        }
      }
    });
    JobPrivateAPI.init(job, state);
    startTimeout();
    JobPrivateAPI.run(this.job);
  },
  cleanup: function(state, deferred) {
    off(this.job);
    JobPrivateAPI.cleanup(this.job);
  }
});

exports.JobScheduler = JobScheduler;
exports.Job = Job;
exports.JobStep = JobStep;
exports.ComposedJobStep = ComposedJobStep;
exports.nsSched = nsSched;