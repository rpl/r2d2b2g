Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
XPCOMUtils.defineLazyServiceGetter(this, "socketTransportService",
                                   "@mozilla.org/network/socket-transport-service;1",
                                   "nsISocketTransportService");

// WORKAROUND: loads debugger transport correctly on b2g-desktop
XPCOMUtils.defineLazyGetter(this, 'DebuggerTransport', function() {
  var loadSubScript =
        "function loadSubScript(aURL)\n" +
        "{\n" +
        "const Ci = Components.interfaces;\n" +
        "const Cc = Components.classes;\n" +
        "  try {\n" +
        "    let loader = Cc[\"@mozilla.org/moz/jssubscript-loader;1\"]\n" +
        "      .getService(Ci.mozIJSSubScriptLoader);\n" +
        "    loader.loadSubScript(aURL, this);\n" +
        "  } catch(e) {\n" +
        "    dump(\"Error loading: \" + aURL + \": \" + e + \" - \" + e.stack + \"\\n\");\n" +
        "    throw e;\n" +
        "  }\n" +
        "}";

  Components.utils.import("resource://gre/modules/devtools/dbg-client.jsm");

  var systemPrincipal = Components.classes["@mozilla.org/systemprincipal;1"]
        .createInstance(Components.interfaces.nsIPrincipal);

  var gGlobal = Components.utils.Sandbox(systemPrincipal);
  Components.utils.evalInSandbox(loadSubScript, gGlobal, "1.8");
  gGlobal.loadSubScript("chrome://global/content/devtools/dbg-server.js");

  return gGlobal.DebuggerTransport;
});

/* NOTE: this simpler version fails on b2g-desktop, but works correctly on firefox nightly
   TODO: collect exception raised to better describe the issue
XPCOMUtils.defineLazyGetter(this, 'DebuggerTransport', function() {
   Cu.import('resource://gre/modules/devtools/dbg-client.jsm');
   return DebuggerTransport;
});*/


window.addEventListener("ContentStart", function() {
  debug("processing -rdp-connect-to command line option");

  // Get the command line arguments that were passed to the b2g client
  let args = window.arguments[0].QueryInterface(Ci.nsICommandLine);
  let rdpConnectTo;

  // Get the --dbgport argument from the command line
  try {
    rdpConnectTo = args.handleFlagWithParam('rdp-connect-to', false);
    // With no value, tell the user how to use it
    if (rdpConnectTo) {
      if (rdpConnectTo == '') {
        usage();
      }

      rdpConnectTo = rdpConnectTo.split(":");

      if (rdpConnectTo.length != 2) {
        usage();
      }

      let host = rdpConnectTo[0],
          port = rdpConnectTo[1];

      window.RDPConnectTo = function() {
        debug("Create an RDP connection to: " + host + ":" + port);
        try {
          DebuggerServer._checkInit();
          let s = socketTransportService.createTransport(null, 0, host, port, null);
          let transport = new DebuggerTransport(s.openInputStream(0, 0, 0),
                                                s.openOutputStream(0, 0, 0));

          DebuggerServer._onConnection(transport);
          transport.ready();
          // TODO: evaluate a configurable reconnection policy
          // (e.g. try to reconnect N times if closed)
        } catch(e) {
          debug("EXCEPTION initializing active RDP connection: " + e + " - " + e.stack);
        }
      };

    }
    debug("################ processing -rdp-connect-to completed #########################");
  }
  catch(e) {
    // If getting the argument value fails, its an error
    fail("EXCEPTION processing -rdp-connect-to '"+e+"': "+e.stack);
    usage();
  }

  function usage() {
    let msg = 'The --dbgport argument specifies the desired remote debugger port.\n' +
      'Use it like this:\n'+
      '\t--dbgport PORT (e.g. --dbgport 6001)\n';
    dump(msg);
    // exit b2g
    Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
  }

  function fail(msg) {
    dump(msg + "\n");
    Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
  }
}, false);
