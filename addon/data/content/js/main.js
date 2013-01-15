var Simulator = {

  APP_TYPES: {
    "packaged": "Packaged App",
    "hosted_generated": "Hosted Generated App",
    "hosted": "Hosted App"
  },

  init: function() {

    this.toggler = $('#command-toggle')[0];
    $(this.toggler).prop('checked', false).on('change', function(evt) {
      // FIXME: Change to actual checkbox state
      Simulator.toggle();
    });

    var current = document.location.hash.substr(1) || 'dashboard';
    Simulator.show('#' + current);

    $(document).on('click', 'a[href^="#"]', function(evt) {
      var target = $(this).attr('href');
      if ($(target)[0].tagName.toLowerCase() == 'section') {
        Simulator.show(target);
      }
    });

    var currentUrl;
    $('#add-app-url').on('keyup change input', function(evt) {
      var url = $(this).val();
      if (url == currentUrl) {
        return;
      }
      currentUrl = url;
      var valid = this.checkValidity();
      console.log(valid);
      $('#action-add-page, #action-add-manifest').prop('disabled', !valid);
      if (!valid) {
        return;
      }

      window.postMessage({name: "validateUrl", url: url}, "*");
    });

    $('#commands-preference-jsconsole').on('change', function(evt) {
      window.postMessage({
        name: "setPreference",
        key: "jsconsole",
        value: $(this).prop("checked")
      }, "*");
    });

    $('#form-add-app').on('submit', function(evt) {
      evt.preventDefault();

      var input = $('#add-app-url');
      var valid = input[0].checkValidity();
      window.postMessage({
        name: "addAppByTab",
        url: input.val()
      }, "*");
    });

    $('#simulator-devtools-connect').on('click', function(evt) {
      evt.preventDefault();

      window.postMessage({
        name: "connectRemoteDeveloperToolbox"
      }, "*");
    });

    document.documentElement.addEventListener(
      "addon-message",
      function addonMessageListener(event) {
        var message = event.detail;
        if (!("name" in message)) {
          return;
        }
        console.log('Addon-message: ' + message.name, JSON.stringify(message));
        switch (message.name) {
          case "jobSchedulerUpdate":  
            var schedulerInfoEl = $("#job-scheduler-running-job");
            if (message.description) {
              schedulerInfoEl.html(message.description);
              schedulerInfoEl.parents('label').css({display: "block"});
            }
            else {
              schedulerInfoEl.html("");
              schedulerInfoEl.parents('label').css({display: "none"});
            }
            break;
          case "getHasDeveloperToolbox":
            if (message.enabled) {
                $("#go-to-devtools").css({display: "block"});
            } else {
                $("#go-to-devtools").css({display: "none"});
            }
            break;
          case "isRunning":
            $(Simulator.toggler).prop('indeterminate', false);
            if (message.isRunning) {
              $(Simulator.toggler).prop('checked', true);
            }
            else {
              $(Simulator.toggler).prop('checked', false);
            }
            break;
          case "listTabs":
            var container = $('#list-app-tabs'), items = [];
            for (var url in message.list) {
              items.push($('<option>').prop('value', url));
            }
            container.empty().append(items);
            break;
          case "setPreference":
            $("#commands-preference-" + message.key).prop("checked", message.value);
            break;
          case "validateUrl":
            var set = $('#add-app-url').parents('form').removeClass('is-manifest');
            if (!message.err) {
              set.addClass('is-manifest');
            } else {
              $('#add-app-url').prop('title', message.err);
            }
            break;
          case "listApps":
            var defaultApp = message.defaultApp || null;
            var container = $('#apps-list').empty();

            var defaultPref = $("#commands-preference-default-app");
            if (defaultApp) {
              defaultPref.text(message.list[defaultApp.number].name).parents('label').show();
            } else {
              defaultPref.parents('label').hide();
            }

            var ids = Object.keys(message.list);
            console.log(ids);
            if (!ids.length) {
              container.append('<em>No Apps added yet? Add some …</em>');
            }
            else {
              container.append($('<button id="listApps-flush">').
                               text("Flush").
                               click(function(evt) {
                                 evt.preventDefault();
                                 window.postMessage({
                                   name: "listApps", 
                                   flush: true
                                 }, "*");
                               }).
                               hide());
            }
            ids.forEach(function(id) {
              // FIXME: forEach workaround as for-in resulted in broken index
              var app = message.list[id];

              var lastUpdate = app.lastUpdate || null;
              if (lastUpdate) {
                lastUpdate = (new Date(app.lastUpdate)).toUTCString();
              } else {
                lastUpdate = "-";
              }

              var options = [];

              var note = Simulator.APP_TYPES[app.type];

              if (app.removed) {
                $("#listApps-flush").show();
                options.push(
                  $("<a href='#'>")
                    .addClass("button")
                    .text("Undo")
                    .click(function(evt) {
                      evt.preventDefault();
                      window.postMessage({name: "undoRemoveApp", id: id}, "*");
                    })
                  );
                note = "has been removed.";
              } else {
                if (app.installed) {
                  options.push(
                    $("<a href='#'>")
                      .addClass("button")
                      .text("Remove")
                      .click(function(evt) {
                        evt.preventDefault();
                        window.postMessage({name: "removeApp", id: id}, "*");
                      }),
                    $("<button>")
                      .text("Update")
                      .click(function(evt) {
                        window.postMessage({name: "updateApp", id: id}, "*");
                      })
                      .prop("title", lastUpdate),
                    $("<button>")
                      .text("Run")
                      .click(function(evt) {
                        window.postMessage({name: "runApp", id: id}, "*");
                      }));
                  } else {
                    options.push(
                      $("<a href='#'>")
                        .addClass("button")
                        .text("Remove")
                        .click(function(evt) {
                          evt.preventDefault();
                          window.postMessage({name: "removeApp", id: id}, "*");
                        }),
                      $("<button>")
                        .text("Install")
                        .click(function(evt) {
                          window.postMessage({name: "installApp", id: id}, "*");
                        })
                        .prop("title", lastUpdate));
                  }

                // $("<label>").append(
                //   $("<span>").text('Run by default:'),
                //   $("<input type='checkbox'>")
                //     .prop('checked', defaultApp == id)
                //     .prop('title', "Launch by default")
                //     .click(function() {
                //       var value = $(this).prop("checked") ? id : null;
                //       window.postMessage({name: "setDefaultApp", id: value}, "*");
                //     })
                //   )
              }

              var entry = $("<div class='app'>").append(
                $("<div class='options'>").append(options),
                $("<h4>").text(app.name).append(
                  $('<small>').text(note)
                )
              );

              if (app.removed) {
                entry.addClass('removed');
              } else {
                entry.append(
                  $("<p>").append(
                    $("<a href='#'>")
                      .text("Open Location")
                      .prop("title", id)
                      .click(function(evt) {
                        evt.preventDefault();
                        window.postMessage({name: "revealApp", id: id}, "*");
                      }),
                    $("<span>")
                      .text(" (" + app.revealUrl + ")")
                  )
                );
              }

              // FIXME: Make an actual list, add a template engine
              container.append(entry);
            });
            break;
        }
      },
      false
    );

    window.postMessage({ name: "getHasDeveloperToolbox" }, "*");
    window.postMessage({ name: "getIsRunning" }, "*");
    // reload apps list on reload
    window.postMessage({ name: "listApps", flush: false }, "*");
    window.postMessage({ name: "listTabs" }, "*");
    window.postMessage({ name: "getPreference" }, "*");
  },

  show: function(target) {
    var to = $(target)[0];
    if (this.section) {
      if (to == this.section) {
        return;
      }
      $(this.section).hide();
      $('a[href="#' + $(this.section).attr('id') + '"]').removeClass('active');
    }
    this.section = to;
    $(this.section).show();
    $('a[href="#' + $(this.section).attr('id') + '"]').addClass('active');
  },

  toggle: function() {
    $(this.toggler).prop('indeterminate', true);
    window.postMessage({ name: "toggle" }, "*");
  },

  create: function() {
    window.postMessage({ name: "create" }, "*");
  },

  addAppByDirectory: function() {
    window.postMessage({ name: "addAppByDirectory" }, "*");
  }

};

$(window).load(function() {
  Simulator.init();
});

