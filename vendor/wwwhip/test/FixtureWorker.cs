// Test-only entry point. Never packaged. Binds exclusively to a test window
// supplied by the fixture process; production process recognition has its own
// native tests. All subsequent checks and actual input use CodexInput.Send.
using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using OpenWhip;

public static class FixtureWorker {
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    private static void Field(string name, object value) {
        typeof(CodexInput).GetField(name, BindingFlags.Static | BindingFlags.NonPublic).SetValue(null, value);
    }
    [MTAThread]
    public static void Main(string[] args) {
        var expectedWindow = new IntPtr(Int64.Parse(args[0]));
        uint expectedPid = UInt32.Parse(args[1]);
        var json = new JavaScriptSerializer();
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        string line;
        while ((line = Console.ReadLine()) != null) {
            object id = null;
            try {
                var request = json.Deserialize<Dictionary<string, object>>(line);
                id = request["id"];
                object result;
                switch ((string)request["command"]) {
                    case "ping": result = new { ready = true }; break;
                    case "bind":
                        uint pid;
                        GetWindowThreadProcessId(expectedWindow, out pid);
                        if (GetForegroundWindow() != expectedWindow || pid != expectedPid)
                            throw new Exception("Only the dedicated fixture window may be bound. Foreground=" + GetForegroundWindow() + "; expected=" + expectedWindow + "; pid=" + pid + "; expectedPid=" + expectedPid);
                        var element = AutomationElement.FocusedElement;
                        typeof(CodexInput).GetMethod("CheckEditor", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, new object[] { element });
                        if (CodexInput.EditorText(element).Length != 0)
                            throw new InputFailure("draft", "Fixture draft present: " + json.Serialize(CodexInput.EditorText(element)));
                        Field("window", expectedWindow);
                        Field("editor", element);
                        Field("runtimeId", element.GetRuntimeId());
                        Field("title", "OpenWhip input fixture");
                        var document = (AutomationElement)typeof(CodexInput).GetMethod("EditorDocument", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, new object[] { element });
                        Field("documentName", document.Current.Name);
                        Field("documentId", document.GetRuntimeId());
                        typeof(CodexInput).GetMethod("BindComposerScope", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, new object[] { element });
                        Field("token", "fixture-only");
                        result = new { token = "fixture-only" };
                        break;
                    case "send": result = CodexInput.Send((string)request["token"], (string)request["text"], (string)request["mode"]); break;
                    default: throw new Exception("Unknown fixture command");
                }
                Console.WriteLine(json.Serialize(new { id = id, ok = true, result = result }));
            } catch (Exception error) {
                while (error.InnerException != null) error = error.InnerException;
                Console.WriteLine(json.Serialize(new { id = id, ok = false, message = error.Message, code = error is InputFailure ? ((InputFailure)error).Code : "fixture" }));
            }
        }
    }
}
