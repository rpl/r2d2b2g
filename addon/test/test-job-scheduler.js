/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const { Class } = require("sdk/core/heritage");
const {Job, JobStep, ComposedJobStep, JobScheduler, nsSched} = require("job-scheduler");

exports["test:JobStep"] = function (test) {
  let runOk, cleanupOk;
  let Step1 = Class({
    extends: JobStep,
    run: function (state,deferred) {
      test.ok(!!state && state.var1 === true, "run should receive a state argument");
      test.ok(!!deferred, "run should receive a deferred argument");
      runOk = true;
    },
    cleanup: function (state,deferred) {
      test.ok(!!state && state.var1 === true, "cleanup should receive a state argument");
      test.ok(!!deferred, "cleanup should receive a deferred argument");
      cleanupOk = true;
    }
  });

  let s1 = Step1();
  let priv = nsSched(JobStep);
  test.ok(("run" in priv) && (typeof priv.run === "function"),
          "JobStep instances should contains a run private function");
  test.ok(("cleanup" in priv) && (typeof priv.cleanup === "function"),
          "JobStep instances should contains a cleanup private function");
  let promise = priv.run(s1,{var1:true});
  test.ok(runOk, "priv.run should execute Step1 run function");
  let promise = priv.cleanup(s1,{var1:true});
  test.ok(cleanupOk, "priv.cleanup should execute Step1 cleanup function");
};

exports["test:Job"] = function (test, done) {
  let runOk, cleanupOk;
  let Step2 = Class({
    name: "Step2",
    extends: JobStep,
    run: function (state,deferred) {
      runOk = true;
      deferred.resolve();
    },
    cleanup: function (state,deferred) {
      cleanupOk = true;
      deferred.resolve();
    }
  });

  let job1 = Job({
    steps: [Step2()]
  });

  let JobPrivateAPI = nsSched(Job);
  job1.on("error", test.fail.bind(test));
  job1.on("progress", function (progress) {
    test.pass("job step completed "+progress.percent+" "+progress.step.toString());
  });
  job1.on("completed", function (data) {
    test.ok(runOk, "Step2 run executed");
    test.ok(cleanupOk, "Step2 cleanup executed");
    done();
  });
  JobPrivateAPI.init(job1,{});
  JobPrivateAPI.run(job1);
};

exports["test:Job error and cleanup"] = function (test, done) {
  let runOk, cleanupOk, errorOk;

  let Step2 = Class({
    name: "Step2",
    extends: JobStep,
    run: function (state,deferred) {
      runOk = true;
      deferred.reject("error message");
    },
    cleanup: function (state,deferred) {
      cleanupOk = true;
      deferred.resolve();
    }
  });

  let job1 = Job({
    steps: [Step2()]
  });

  let JobPrivateAPI = nsSched(Job);
  job1.on("error", function (errorData) {
    errorOk = true;
    test.ok("error" in errorData, "errorData should contains an error attribute");
    test.ok("errorStepIndex" in errorData, "errorData should contains an errorStepIndex attribute");
    test.ok("step" in errorData, "errorData should contains a step attribute");
  });
  job1.on("completed", function (data) {
    test.ok("success" in data, "data should contains a success attribute");
    test.ok(runOk, "Step2 run executed");
    test.ok(cleanupOk, "Step2 cleanup executed");
    done();
  });
  JobPrivateAPI.init(job1,{});
  JobPrivateAPI.run(job1);
};

exports["test:ComposedJobStep"] = function (test, done) {
  test._log.waitUntilDone(30000);
  let runCount = 0, cleanupCount = 0;

  let Step1 = Class({
    name: "Step1",
    extends: JobStep,
    run: function (state,deferred) {
      runCount++;
    },
    cleanup: function (state,deferred) {
      cleanupCount++;
      deferred.resolve();
    }
  });

  let step1 = ComposedJobStep({
    steps: [Step1()],
    maxRetries: 3,
    timeout: 200,
  });

  let priv = nsSched(JobStep);
  let promise = priv.run(step1,{var1:true});
  promise.then(function() {
    test.fail("run should timeout");
  },function() {
    test.ok(runCount === 3, "run should be called 3 times");
    test.ok(cleanupCount === 3, "cleanup should be called 3 times");
    done();
  });
};

exports["test:JobScheduler"] = function (test, done) {
  test._log.waitUntilDone(30000);

  let jobScheduler = JobScheduler({var1: 5});

  let runOk, cleanupOk;
  let Step2 = Class({
    name: "Step2",
    extends: JobStep,
    run: function (state,deferred) {
      runOk = true;
      deferred.resolve();
    },
    cleanup: function (state,deferred) {
      cleanupOk = true;
      deferred.resolve();
    }
  });

  let job = jobScheduler.enqueueJob({
    steps: [Step2()]
  });

  test.ok(job, "job should be queued");

  job.on("completed", function(data) {
    if (data.success) {
      done();
    } else {
      test.fail(data.error);
    }
  });

  jobScheduler.processQueue();
};


require('sdk/test').run(exports);