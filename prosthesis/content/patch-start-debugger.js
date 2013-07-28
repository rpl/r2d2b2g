// patch startDebugger to add simulator-actors and pingback simulator manager
// on ready.
{
  debug("patch RemoteDebugger.start");

  // add simulator actors
  let presimulator_RemoteDebugger_start = RemoteDebugger.start.bind(RemoteDebugger);
  RemoteDebugger.start = function simulatorRemoteDebuggerStart() {
    presimulator_RemoteDebugger_start(); // call original RemoteDebugger.start
    DebuggerServer.addActors('chrome://prosthesis/content/dbg-simulator-actors.js');
    // NOTE: add temporary simulatorWebAppsActor
    DebuggerServer.addActors('chrome://prosthesis/content/dbg-webapps-actors.js');
    // Register our copy of styleeditor until it gets uplifted to b2g18
    DebuggerServer.addActors('chrome://prosthesis/content/dbg-styleeditor-actors.js');
    DebuggerServer.addTabActor(DebuggerServer.StyleEditorActor, "styleEditorActor");
    if (window.RDP_CONNECT_TO) {
      let host = window.RDP_CONNECT_TO["host"];
      let port = window.RDP_CONNECT_TO["port"];

      debug("RDP CONNECT TO "+host+":"+port+"\n");

      try {
        DebuggerServer.connectToTCPServer(host, port);
      } catch(e) {
        debug("EXCEPTION ON RDP CONNECT: "+e+" "+e.fileName+":"+e.lineNumber+"\n");
      }
    }
  };

  // allow remote debugger connection without any user confirmation
  RemoteDebugger.prompt = function() {
    this._promptDone = true;
    this._promptAnswer = true;
    return true;
  };
}
