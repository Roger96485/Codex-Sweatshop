using System;
using System.Collections.Generic;
using System.Text;
using System.Web.Script.Serialization;

namespace OpenWhip {
    public static class Worker {
        [MTAThread]
        public static void Main() {
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
            var json = new JavaScriptSerializer { MaxJsonLength = 16384 };
            string line;
            while ((line = Console.ReadLine()) != null) {
                object id = null;
                object response;
                try {
                    var request = json.Deserialize<Dictionary<string, object>>(line);
                    id = request["id"];
                    object result;
                    switch ((string)request["command"]) {
                        case "ping": result = new { ready = true, inputSize = CodexInput.InputSize() }; break;
                        case "bind": result = CodexInput.Bind(); break;
                        case "send": result = CodexInput.Send((string)request["token"], (string)request["text"], (string)request["mode"]); break;
                        default: throw new InputFailure("command", "Unknown input command.");
                    }
                    response = new { id = id, ok = true, result = result };
                } catch (Exception error) {
                    response = new { id = id, ok = false, code = error is InputFailure ? ((InputFailure)error).Code : "unavailable", message = error.Message };
                }
                Console.WriteLine(json.Serialize(response));
            }
        }
    }
}
