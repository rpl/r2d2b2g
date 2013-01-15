/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const { Class } = require("sdk/core/heritage");
const { defer } = require("sdk/core/promise");
const {Job, CompositeJob, JobScheduler} = require("job-scheduler");

exports["test:Job.run:success"] = function (test,done) {
  let counters = {run: 0, cancel: 0, cleanup: 0};
  let TestJob = Class({
    name: "StepRunSuccess",
    extends: Job,
    handleRun: function (ctx,deferred) {
      test.ok(!!ctx && ctx.var1 === true, "run should receive the ctx argument");
      test.ok(!!deferred, "run should receive a deferred argument");
      counters.run++;
      // run exits with success
      deferred.resolve();
    },
    handleCancel: function (ctx,deferred) {
      test.fail("handleCancel should not be executed");
      // cancel exits with success
      deferred.resolve();
    },
    handleCleanup: function (ctx,deferred) {
      test.ok(!!ctx && ctx.var1 === true, "cleanup should receive a ctx argument");
      test.ok(!!deferred, "cleanup should receive a deferred argument");
      counters.cleanup++;
      // cleanup exits with success
      deferred.resolve();
    }
  });

  let job = TestJob();
  job.run({var1:true}).then(function () {
    test.equal(counters["run"],1, "run should execute Step1 run function once");
    test.equal(counters["cleanup"],1, "run should execute Step1 cleanup function once");
    test.equal(job.success,true, "job.success should be true");
    done();
  });
};

exports["test:Job.run:error"] = function (test,done) {
  let counters = {run: 0, cancel: 0, cleanup: 0};
  let TestJob = Class({
    name: "StepRunAsyncError",
    extends: Job,
    handleRun: function (ctx,deferred) {
      counters.run++;
      // run exits with error
      throw Error("runError");
    },
    handleCancel: function (ctx,deferred) {
      test.fail("handleCancel should not be executed");
      // cancel exit with success
      deferred.resolve();
    },
    handleCleanup: function (ctx,deferred) {
      counters.cleanup++;
      // cleanup exit with success
      deferred.resolve();
    }
  });

  let job = TestJob();
  job.run({var1:true}).then(function () {
    test.equal(counters["run"],1, "run should execute Step1 run function once");
    test.equal(counters["cleanup"],1, "run should execute Step1 cleanup function once");
    test.equal(job.success,false, "job.success should be false");
    test.equal(job.error.message,"runError", "job.error.message");
    done();
  });
};

exports["test:Job.run:asyncError"] = function (test,done) {
  let counters = {run: 0, cancel: 0, cleanup: 0};
  let TestJob = Class({
    name: "StepRunAsyncError",
    extends: Job,
    handleRun: function (ctx,deferred) {
      counters.run++;
      // run exits with error
      deferred.reject(Error("asyncError"));
    },
    handleCancel: function (ctx,deferred) {
      test.fail("handleCancel should not be executed");
      // cancel exit with success
      deferred.resolve();
    },
    handleCleanup: function (ctx,deferred) {
      counters.cleanup++;
      // cleanup exit with success
      deferred.resolve();
    }
  });

  let job = TestJob();
  job.run({var1:true}).then(function () {
    test.equal(counters["run"],1, "run should execute Step1 run function once");
    test.equal(counters["cleanup"],1, "run should execute Step1 cleanup function once");
    test.equal(job.success,false, "job.success should be false");
    test.equal(job.error.message,"asyncError", "job.error.message");
    done();
  });
};

exports["test:Job.run:asyncErrorCleanupError"] = function (test,done) {
  let counters = {run: 0, cancel: 0, cleanup: 0};
  let TestJob = Class({
    name: "StepRunAsyncError",
    extends: Job,
    handleRun: function (ctx,deferred) {
      counters.run++;
      // run exits with error
      deferred.reject(Error("asyncError"));
    },
    handleCancel: function (ctx,deferred) {
      test.fail("handleCancel should not be executed");
      // cancel exit with success
      deferred.resolve();
    },
    disableWarn: true,
    handleCleanup: function (ctx,deferred) {
      counters.cleanup++;
      // cleanup exit with error
      deferred.reject(Error("cleanupAsyncError"));
    }
  });

  let job = TestJob();
  job.run({var1:true}).then(function () {
    test.equal(counters["run"],1, "run should execute Step1 run function once");
    test.equal(counters["cleanup"],1, "run should execute Step1 cleanup function once");
    test.equal(job.success,false, "job.success should be false");
    test.equal(job.error.message,"asyncError", "job.error.message should be equal to 'asyncError'");
    test.equal(job.successCleanup,false, "job.successCleanup should be true");
    test.equal(job.errorCleanup.message,"cleanupAsyncError", "job.errorCleanup.message");
    done();
  });
};

exports["test:Job.run:abort"] = function (test,done) {
  let counters = {run: 0, cancel: 0, cleanup: 0};
  let TestJob = Class({
    name: "StepRunAbort",
    extends: Job,
    handleRun: function (ctx,deferred) {
      counters.run++;
      // run stucked no timeout defined
    },
    handleCancel: function (ctx,deferred) {
      counters.cancel++;
      test.ok(!!ctx && ctx.var1 === true, "cancel should receive a ctx argument");
      test.ok(!!deferred, "cancel should receive a deferred argument");
      // cancel exit with success
      deferred.resolve();
    },
    handleCleanup: function (ctx,deferred) {
      counters.cleanup++;
      // cleanup exit with success
      deferred.resolve();
    }
  });

  let job = TestJob();
  job.run({var1:true}).then(function() {
    test.pass("run deferred exit correctly");
  });
  job.abort("abortReason").then(function () {
    test.equal(counters.run,1, "run should execute Step1 run function once");
    test.equal(counters.cancel,1, "run should execute Step1 cancel function once");
    test.equal(counters.cleanup,1, "run should execute Step1 cleanup function once");
    test.equal(job.success,false, "job.success should be false");
    test.equal(job.isAbort,true, "job.isAbort should be true");
    test.equal(job.abortReason,"abortReason", "job.abortReason");
    done();
  });
};

exports["test:Job.run:abortCancelAsyncError"] = function (test,done) {
  let counters = {run: 0, cancel: 0, cleanup: 0};
  let TestJob = Class({
    name: "StepRunAbort",
    extends: Job,
    disableWarn: true,
    handleRun: function (ctx,deferred) {
      counters.run++;
      // run stucked no timeout defined
    },
    handleCancel: function (ctx,deferred) {
      counters.cancel++;
      // deferred reject
      deferred.reject(Error("cancelAsyncError"));
    },
    handleCleanup: function (ctx,deferred) {
      counters.cleanup++;
      // cleanup exit with success
      deferred.resolve();
    }
  });

  let job = TestJob();
  job.run({var1:true}).then(function() {
    test.pass("run deferred exit correctly");
  });
  job.abort("abortReason").then(function () {
    test.equal(job.success,false, "job.success should be false");
    test.equal(job.isAbort,true, "job.isAbort should be true");
    test.equal(job.successCancel,false, "job.successCancel");
    test.equal(job.errorCancel.message,"cancelAsyncError", "job.errorCancel.message");
    done();
  });
};

exports["test:Job.run:abortCancelAndCleanupAsyncError"] = function (test,done) {
  let counters = {run: 0, cancel: 0, cleanup: 0};
  let TestJob = Class({
    name: "StepRunAbort",
    extends: Job,
    disableWarn: true,
    handleRun: function (ctx,deferred) {
      counters.run++;
      // run stucked no timeout defined
    },
    handleCancel: function (ctx,deferred) {
      counters.cancel++;
      // deferred reject
      deferred.reject(Error("cancelAsyncError"));
    },
    handleCleanup: function (ctx,deferred) {
      counters.cleanup++;
      // deferred reject
      deferred.reject(Error("cleanupAsyncError"));
    }
  });

  let job = TestJob();
  job.run({var1:true}).then(function() {
    test.pass("run deferred exit correctly");
  });
  job.abort("abortReason").then(function () {
    test.equal(job.success,false, "job.success should be false");
    test.equal(job.isAbort,true, "job.isAbort should be true");
    test.equal(job.successCancel,false, "job.successCancel");
    test.equal(job.errorCancel.message,"cancelAsyncError", "job.errorCancel.message");
    test.equal(job.successCleanup,false, "job.successCleanup should be false");
    test.equal(job.errorCleanup.message,"cleanupAsyncError", "job.errorCleanup.message");
    done();
  });
};

exports["test:Job.run:abortCancelAndCleanupError"] = function (test,done) {
  let counters = {run: 0, cancel: 0, cleanup: 0};
  let TestJob = Class({
    name: "StepRunAbort",
    extends: Job,
    disableWarn: true,
    handleRun: function (ctx,deferred) {
      counters.run++;
      // run stucked no timeout defined
    },
    handleCancel: function (ctx,deferred) {
      counters.cancel++;
      // throw an error
      throw Error("cancelError");
    },
    handleCleanup: function (ctx,deferred) {
      counters.cleanup++;
      // throw an error
      throw Error("cleanupError");
    }
  });

  let job = TestJob();
  job.run({var1:true}).then(function() {
    test.pass("run deferred exit correctly");
  });
  job.abort("abortReason").then(function () {
    test.equal(job.success,false, "job.success should be false");
    test.equal(job.isAbort,true, "job.isAbort should be true");
    test.equal(job.successCancel,false, "job.successCancel");
    test.equal(job.errorCancel.message,"cancelError", "job.errorCancel.message");
    test.equal(job.successCleanup,false, "job.successCleanup should be false");
    test.equal(job.errorCleanup.message,"cleanupError", "job.errorCleanup.message");
    done();
  });
};

exports["test:Job.run:failedTimeoutMaxRetries"] = function (test,done) {
  let counters = {run: 0, cancel: 0, cleanup: 0};
  let TestJob = Class({
    name: "StepRunAbort",
    extends: Job,
    disableWarn: true,
    handleRun: function (ctx,deferred) {
      counters.run++;
      // run stucked no timeout defined
    },
    handleCancel: function (ctx,deferred) {
      counters.cancel++;
      // throw an error
      throw Error("cancelError");
    },
    handleCleanup: function (ctx,deferred) {
      counters.cleanup++;
      // throw an error
      throw Error("cleanupError");
    }
  });

  let job = TestJob({timeout: 10, maxRetries: 3});
  job.run({var1:true}).then(function() {
    test.pass("run deferred exit correctly");
    test.equal(counters.run,3, "job.handleRun should be executed 3 times");
    test.equal(counters.cancel,3, "job.handleCancel should be executed 3 times");
    test.equal(counters.cleanup,1, "job.handleCleanup should be executed 3 times");
    test.equal(job.success,false, "job.success should be false");
    test.equal(job.error.message,"max retries reached", "job.error.message");
    test.equal(job.isAbort,false, "job.isAbort should be true");
    test.equal(job.successCancel,false, "job.successCancel");
    test.equal(job.errorCancel.message,"cancelError", "job.errorCancel.message");
    test.equal(job.successCleanup,false, "job.successCleanup should be false");
    test.equal(job.errorCleanup.message,"cleanupError", "job.errorCleanup.message");
    done();
  });
};

exports["test:ComposedJob progress events"] = function (test, done) {
  let runOk, cleanupOk, errorOk;

  let Step2 = Class({
    name: "Step2",
    extends: Job,
    handleRun: function (state,deferred) {
      runOk = true;
      deferred.reject("error message");
    },
    handleCleanup: function (state,deferred) {
      cleanupOk = true;
      deferred.resolve();
    }
  });

  let job1 = CompositeJob({
    steps: [Step2()]
  });

  job1.on("progress", function (progress) {
    errorOk = true;
    test.ok("index" in progress, "index attribute");
    test.ok("error" in progress, "error attribute");
  });
  job1.run({}).then(function () {
    test.ok("success" in job1, "job1 should contains a success attribute");
    test.ok(runOk, "Step2 run executed");
    test.ok(cleanupOk, "Step2 cleanup executed");
    done();
  });;
};

exports["test:CompositeJob"] = function (test, done) {
  let runOk, cleanupOk;
  let Step2 = Class({
    name: "Step2",
    extends: Job,
    handleRun: function (state,deferred) {
      runOk = true;
      deferred.resolve();
    },
    handleCleanup: function (state,deferred) {
      cleanupOk = true;
      deferred.resolve();
    }
  });

  let job1 = CompositeJob({
    name: "Job1",
    steps: [Step2()]
  });

  job1.on("progress", function (progress) {
    test.pass("job step completed "+JSON.stringify(progress));
  });
  job1.run({}).then(function () {
    test.ok(runOk, "Step2 run executed");
    test.ok(cleanupOk, "Step2 cleanup executed");
    done();
  });
};

exports["test:CompositeJob:timeoutRetries"] = function (test, done) {
  test._log.waitUntilDone(30000);
  let runCount = 0, cancelCount = 0, cleanupCount = 0;

  let Step1 = Class({
    name: "Step1",
    extends: Job,
    handleRun: function (state,deferred) {
      runCount++;
    },
    handleCancel: function (state,deferred) {
      cancelCount++;
      deferred.resolve();
    },
    handleCleanup: function (state,deferred) {
      cleanupCount++;
      deferred.resolve();
    }
  });

  let job1 = CompositeJob({
    steps: [Step1({    
      maxRetries: 3,
      timeout: 200,
    })]
  });

  let promise = job1.run({var1:true});
  promise.then(function() {
    test.ok(!job1.success, "run should timeout");
    test.ok(runCount === 3, "run should be called 3 times");
    test.ok(cancelCount === 3, "cancel should be called 3 times");
    test.ok(cleanupCount === 1, "cleanup should be called 1 time");
    done();
  });
};

exports["test:CompositeJob:onProgress"] = function (test, done) {
  let runOk, cleanupOk;
  let StepDef = Class({
    name: "Step2",
    extends: Job,
    handleRun: function (priv,deferred) {
      throw Error("BOOM!!!");
    },
    handleCleanup: function(priv,deferred) {
      test.pass("cleanup");
      deferred.resolve();
    },
    handleCancel: function(priv,deferred) {
      test.pass("cancel");
      deferred.resolve();
    }
  });

  let jb = CompositeJob({
    steps: [StepDef({maxRetries: 3, timeout: 50})],
    onProgress: function(d) console.debug(JSON.stringify(d))
  });
  jb.run({}).then(function () {
    test.ok(!jb.success, "job.success should be false");
    test.ok(jb.error, "job.error should not be null");
    console.debug(jb.error);
  }).then(done);
};

exports["test:JobScheduler"] = function (test, done) {
  test._log.waitUntilDone(30000);

  let jobScheduler = JobScheduler({var1: 5});

  let runOk, cleanupOk;
  let Step2 = Class({
    name: "Step2",
    extends: Job,
    handleRun: function (state,deferred) {
      runOk = true;
      deferred.resolve();
    },
    handleCleanup: function (state,deferred) {
      cleanupOk = true;
      deferred.resolve();
    }
  });

  let job = jobScheduler.enqueueJob({
    steps: [Step2()]
  });

  test.ok(job, "job should be queued");

  jobScheduler.on("completed", function(job) {
    if (job.success) {
      done();
    } else {
      test.fail(job.error);
      done();
    }
  });

  jobScheduler.processQueue();
};

require('sdk/test').run(exports);