using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

namespace OpenWhip {
    public sealed class InputFailure : Exception {
        public string Code { get; private set; }
        public InputFailure(string code, string message) : base(message) { Code = code; }
    }

    public static class CodexInput {
        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public UIntPtr extra; }
        [StructLayout(LayoutKind.Explicit)]
        public struct INPUTUNION {
            [FieldOffset(0)] public KEYBDINPUT keyboard;
            [FieldOffset(0)] public MOUSEINPUT mouse;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT { public uint type; public INPUTUNION value; }

        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int size);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
        [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, INPUT[] inputs, int size);

        private static AutomationElement editor;
        private static IntPtr window;
        private static string token;
        private static int[] runtimeId;
        private static string title;
        private static string documentName;
        private static int[] documentId;
        private static AutomationElement composerScope;
        private static string composerName;

        // Exact accessible labels from Codex Desktop, including current and older
        // English / simplified Chinese / traditional Chinese composers. Unknown
        // labels fail closed instead of accepting a terminal or code editor.
        private static readonly HashSet<string> ComposerNames = new HashSet<string>(StringComparer.Ordinal) {
            "给 ChatGPT 发消息", "Message ChatGPT", "傳送訊息給 ChatGPT",
            "使用 ChatGPT Work",
            "Do anything", "Ask Codex to do anything", "Ask for follow-up changes",
            "Ask for follow-up changes or @ mention agents",
            "Ask Codex anything. Type @ to use plugins or mention files",
            "随心输入", "向 Codex 下达任意指令", "提出后续变更要求",
            "要求提供后续变更或 @ 提及智能体", "可向 Codex 询问任何问题。输入 @ 使用插件或提及文件",
            "想做什麼都可以", "要求 Codex 做任何事", "要求後續跟進變更",
            "要求後續跟進變更或以 @ 標記智慧體", "任何事都可問 Codex。輸入 @ 使用外掛程式或提及檔案"
        };

        public static int InputSize() { return Marshal.SizeOf(typeof(INPUT)); }

        public static bool IsCodexExecutable(string path) {
            if (String.IsNullOrEmpty(path)) return false;
            string normalized = path.Replace('/', '\\');
            string file = Path.GetFileName(normalized);
            bool codex = file.Equals("Codex.exe", StringComparison.OrdinalIgnoreCase);
            bool chatgpt = file.Equals("ChatGPT.exe", StringComparison.OrdinalIgnoreCase);
            if (!codex && !chatgpt) return false;
            // Modern Store build retained the OpenAI.Codex package identity.
            if (normalized.IndexOf("\\OpenAI.Codex_", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            // Traditional unpackaged Codex desktop installations. The GUI class
            // and the focused composer are checked separately, excluding CLI.
            return codex && normalized.IndexOf("\\Codex\\", StringComparison.OrdinalIgnoreCase) >= 0
                && normalized.IndexOf("\\bin\\", StringComparison.OrdinalIgnoreCase) < 0;
        }

        public static bool IsComposerName(string name) {
            return ComposerNames.Contains((name ?? "").Replace("\u200b", "").Trim());
        }

        private static string WindowTitle(IntPtr handle) {
            var buffer = new StringBuilder(512);
            GetWindowText(handle, buffer, buffer.Capacity);
            return buffer.ToString();
        }

        private static void Fail(string code, string message) { throw new InputFailure(code, message); }

        private static bool SameId(int[] left, int[] right) {
            if (left == null || right == null || left.Length != right.Length) return false;
            for (int i = 0; i < left.Length; i++) if (left[i] != right[i]) return false;
            return true;
        }

        private static bool BelongsToWindow(AutomationElement element, IntPtr handle) {
            for (int depth = 0; element != null && depth < 32; depth++) {
                if (element.Current.NativeWindowHandle == handle.ToInt64()) return true;
                object pattern;
                if (element.TryGetCurrentPattern(WindowPattern.Pattern, out pattern)
                    && ((WindowPattern)pattern).Current.IsModal) return false;
                element = TreeWalker.ControlViewWalker.GetParent(element);
            }
            return false;
        }

        private static bool HasClass(AutomationElement element, string name) {
            return element != null && Array.IndexOf((element.Current.ClassName ?? "").Split(' '), name) >= 0;
        }

        // Chromium includes generated CSS placeholder text in both patterns.
        // Codex's placeholderPlugin marks only its single empty paragraph as
        // "placeholder". The current :before / form layout can expose only the
        // label, while older :after layouts expose a trailingBreak first.
        // Text equality alone is never enough to treat a draft as empty.
        public static string EditorText(AutomationElement element) {
            object pattern;
            string raw = null;
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) {
                var value = (ValuePattern)pattern;
                if (value.Current.IsReadOnly) Fail("readonly", "The Codex input is read-only.");
                raw = value.Current.Value;
            }
            else if (element.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) {
                var text = (TextPattern)pattern;
                raw = text.DocumentRange.GetText(4096);
            }
            if (raw == null) Fail("unreadable", "Cannot verify the Codex draft. No keys were sent.");
            if (raw.Length == 0) return raw;
            string name = element.Current.Name;
            if (!HasClass(element, "ProseMirror")) return raw;
            if (raw != "\n" && raw != "\r\n" && raw != name
                && raw != "\n" + name && raw != "\r\n" + name
                && raw != name + "\n" && raw != name + "\r\n") return raw;

            // Inspect only the bound editor; other composers cannot prove it empty.
            var leaves = element.FindAll(TreeScope.Descendants,
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text));
            if (leaves.Count < 1 || leaves.Count > 2) return raw;
            if (leaves.Count == 1 && HasClass(leaves[0], "ProseMirror-trailingBreak")
                && (raw == "\n" || raw == "\r\n")) return "";
            AutomationElement placeholder = null, paragraph = null;
            foreach (AutomationElement leaf in leaves) {
                if (HasClass(leaf, "ProseMirror-trailingBreak")) continue;
                if (placeholder != null || leaf.Current.Name != name) return raw;
                placeholder = leaf;
                var ancestor = TreeWalker.RawViewWalker.GetParent(leaf);
                for (int depth = 0; ancestor != null && depth < 4; ancestor = TreeWalker.RawViewWalker.GetParent(ancestor), depth++) {
                    if (SameId(ancestor.GetRuntimeId(), element.GetRuntimeId())) break;
                    if (HasClass(ancestor, "placeholder")) {paragraph = ancestor;break;}
                }
            }
            if (placeholder == null || paragraph == null) return raw;
            foreach (AutomationElement leaf in leaves) {
                bool inside = false;
                var ancestor = TreeWalker.RawViewWalker.GetParent(leaf);
                for (int depth = 0; ancestor != null && depth < 4; ancestor = TreeWalker.RawViewWalker.GetParent(ancestor), depth++) {
                    if (SameId(ancestor.GetRuntimeId(), paragraph.GetRuntimeId())) {inside = true;break;}
                    if (SameId(ancestor.GetRuntimeId(), element.GetRuntimeId())) break;
                }
                if (!inside) return raw;
            }
            return "";
        }

        private static AutomationElement EditorDocument(AutomationElement element) {
            for (int depth = 0; element != null && depth < 32; depth++) {
                if (element.Current.ControlType == ControlType.Document) return element;
                element = TreeWalker.ControlViewWalker.GetParent(element);
            }
            Fail("document", "Cannot identify the Codex task. Activate the whip again.");
            return null;
        }

        private static void CheckEditor(AutomationElement element) {
            if (element == null || element.Current.ControlType != ControlType.Edit
                || !element.Current.IsEnabled || element.Current.IsOffscreen || element.Current.IsPassword
                || !IsComposerName(element.Current.Name)) {
                Fail("composer", "Click the empty Codex message box, then press Ctrl+Alt+W. This input is not a supported Codex composer.");
            }
        }

        // Bind the immediate composer body as well as the document. A quick
        // chat can share the document with the main thread's message box.
        private static void BindComposerScope(AutomationElement element) {
            composerScope = TreeWalker.ControlViewWalker.GetParent(element);
            composerName = element.Current.Name;
            if (composerScope == null) Fail("composer", "Cannot identify the message composer container.");
        }

        public static object Bind() {
            token = null;
            editor = null;
            window = GetForegroundWindow();
            uint pid;
            GetWindowThreadProcessId(window, out pid);
            var className = new StringBuilder(128);
            GetClassName(window, className, className.Capacity);
            string executable = "";
            try { using (var process = Process.GetProcessById((int)pid)) executable = process.MainModule.FileName; }
            catch { Fail("process", "Cannot identify the foreground app. Open Codex at the same privilege level as Whip."); }
            if (!className.ToString().StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal)
                || !IsCodexExecutable(executable)) Fail("target", "Focus Codex Desktop before activating the whip.");
            var focused = AutomationElement.FocusedElement;
            CheckEditor(focused);
            if (!BelongsToWindow(focused, window)) Fail("focus", "The message box does not belong to the foreground Codex window.");
            if (EditorText(focused).Length != 0) Fail("draft", "The Codex message box already has a draft. Send or clear it yourself first.");
            if (GetForegroundWindow() != window) Fail("focus", "Focus changed while activating the whip. Try again.");
            editor = focused;
            runtimeId = focused.GetRuntimeId();
            title = WindowTitle(window);
            var document = EditorDocument(focused);
            documentName = document.Current.Name;
            documentId = document.GetRuntimeId();
            BindComposerScope(focused);
            token = Guid.NewGuid().ToString("N");
            return new { token = token, title = title, documentName = documentName, composerName = composerName };
        }

        private static void CheckTarget() {
            if (editor == null || GetForegroundWindow() != window || WindowTitle(window) != title)
                Fail("focus", "The target window or task changed. Activate the whip again in the intended Codex message box.");
            var focused = AutomationElement.FocusedElement;
            CheckEditor(focused);
            if (!SameId(runtimeId, focused.GetRuntimeId()) || !BelongsToWindow(focused, window))
                Fail("focus", "The focused input changed. Activate the whip again in the Codex message box.");
            var document = EditorDocument(focused);
            if (document.Current.Name != documentName || !SameId(documentId, document.GetRuntimeId()))
                Fail("focus", "The Codex task changed. Activate the whip again in the intended task.");
            var scope = TreeWalker.ControlViewWalker.GetParent(focused);
            if (focused.Current.Name != composerName || scope == null || !SameId(scope.GetRuntimeId(), composerScope.GetRuntimeId()))
                Fail("focus", "The message composer or mode changed. Activate the whip again.");
            editor = focused;
        }

        private static void CheckModifiers() {
            foreach (int key in new int[] { 0x10, 0x11, 0x12, 0x5b, 0x5c })
                if ((GetAsyncKeyState(key) & 0x8000) != 0) Fail("modifier", "Release Shift, Ctrl, Alt and Windows keys before whipping.");
        }

        // Submission can remount the editor. Reacquire it only inside the same
        // bound document, without moving focus or sending any further keys.
        private static AutomationElement SubmittedEditor(AutomationElement document) {
            // A successful first submission can name the new conversation.
            // Keep the document identity and original composer container pinned;
            // its display title is only a pre-submission guard.
            if (!SameId(documentId, document.GetRuntimeId()))
                Fail("focus", "The Codex task changed after submission.");
            var candidates = composerScope.FindAll(TreeScope.Descendants,
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
            AutomationElement found = null;
            foreach (AutomationElement candidate in candidates) {
                if (candidate.Current.Name != composerName || candidate.Current.IsOffscreen) continue;
                if (found != null) return null;
                found = candidate;
            }
            return found;
        }

        private static AutomationElement OnlyVisibleComposer(AutomationElement document) {
            AutomationElement found = null;
            foreach (AutomationElement candidate in document.FindAll(TreeScope.Descendants,
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit))) {
                if (candidate.Current.IsOffscreen || !IsComposerName(candidate.Current.Name)) continue;
                if (found != null) return null;
                found = candidate;
            }
            return found;
        }

        private static bool HasPostedMessage(AutomationElement container, string text) {
            var matches = container.FindAll(TreeScope.Descendants, new AndCondition(
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text),
                new PropertyCondition(AutomationElement.NameProperty, text)));
            foreach (AutomationElement match in matches) {
                for (var ancestor = TreeWalker.RawViewWalker.GetParent(match); ancestor != null;
                    ancestor = TreeWalker.RawViewWalker.GetParent(ancestor)) {
                    if (SameId(ancestor.GetRuntimeId(), container.GetRuntimeId()) || ancestor.Current.ControlType == ControlType.Edit) break;
                    if (HasClass(ancestor, "bg-user-message")) return true;
                }
            }
            return false;
        }

        // The new-chat page replaces the entire composer, not just its editor.
        // Confirm that transition only with the exact newly posted user message
        // in the focused composer's transcript; an unrelated empty box is not evidence.
        private static bool NewConversationAccepted(AutomationElement document, string text) {
            if (!SameId(documentId, document.GetRuntimeId())) return false;
            var candidate = OnlyVisibleComposer(document);
            if (candidate == null || candidate.Current.Name != composerName
                || !SameId(candidate.GetRuntimeId(), AutomationElement.FocusedElement.GetRuntimeId())
                || EditorText(candidate).Length != 0) return false;
            for (var ancestor = TreeWalker.RawViewWalker.GetParent(candidate); ancestor != null;
                ancestor = TreeWalker.RawViewWalker.GetParent(ancestor)) {
                if (SameId(ancestor.GetRuntimeId(), documentId)) break;
                if (HasClass(ancestor, "group/thread-scroll-layout")) return HasPostedMessage(ancestor, text);
            }
            return false;
        }

        public static INPUT[] TextInputs(string text) {
            if (String.IsNullOrWhiteSpace(text) || text.Length > 2000) Fail("text", "Message must contain 1-2000 characters.");
            var result = new List<INPUT>();
            // Windows expects UTF-16 code units, including both halves of emoji.
            for (int i = 0; i < text.Length; i++) {
                char character = text[i];
                if (Char.IsControl(character)) Fail("text", "Control characters and multiline messages are not supported yet.");
                if (Char.IsHighSurrogate(character) && (i + 1 >= text.Length || !Char.IsLowSurrogate(text[i + 1])))
                    Fail("text", "Invalid Unicode message.");
                if (Char.IsLowSurrogate(character) && (i == 0 || !Char.IsHighSurrogate(text[i - 1])))
                    Fail("text", "Invalid Unicode message.");
                result.Add(Key(0, character, 0x0004));
                result.Add(Key(0, character, 0x0004 | 0x0002));
            }
            return result.ToArray();
        }

        private static INPUT Key(ushort vk, ushort scan, uint flags) {
            return new INPUT { type = 1, value = new INPUTUNION { keyboard = new KEYBDINPUT { vk = vk, scan = scan, flags = flags } } };
        }

        public static INPUT[] SubmitInputs(string mode) {
            if (mode == "enter") return new INPUT[] { Key(0x0d, 0, 0), Key(0x0d, 0, 2) };
            if (mode == "ctrl-enter") return new INPUT[] { Key(0x11, 0, 0), Key(0x0d, 0, 0), Key(0x0d, 0, 2), Key(0x11, 0, 2) };
            if (mode == "fill") return new INPUT[0];
            Fail("mode", "Unknown submit shortcut.");
            return null;
        }

        private static void Inject(INPUT[] events, bool releaseControlOnFailure = false) {
            uint inserted = SendInput((uint)events.Length, events, InputSize());
            if (inserted != events.Length) {
                // A partial Ctrl+Enter must not leave synthetic Ctrl held down.
                // Releasing keys cannot submit or repeat the message.
                if (releaseControlOnFailure) {
                    var releases = new INPUT[] { Key(0x0d, 0, 2), Key(0x11, 0, 2) };
                    SendInput(2, releases, InputSize());
                }
                Fail("partial", "Windows blocked part of the input. Delivery is unknown; check Codex before trying again.");
            }
        }

        public static object Send(string requestedToken, string text, string mode) {
            if (token == null || token != requestedToken) Fail("binding", "The target is no longer bound. Activate the whip again.");
            try {
                var textEvents = TextInputs(text);
                var submitEvents = SubmitInputs(mode);
                CheckTarget();
                CheckModifiers();
                if (EditorText(editor).Length != 0) Fail("draft", "A draft is present. Nothing was sent; send or clear the draft yourself.");
                CheckTarget();
                Inject(textEvents);
                // Observe the actual draft before sending a control key. No
                // clipboard overwrite, blind Enter, automatic focus or retries.
                bool matched = false;
                var verification = Stopwatch.StartNew();
                while (verification.ElapsedMilliseconds < 2000) {
                    Thread.Sleep(50);
                    CheckTarget();
                    if (EditorText(editor) == text) { matched = true; break; }
                }
                if (!matched) Fail("draft-mismatch", "Could not verify the inserted message. No submit key was sent; check the Codex draft.");
                if (mode == "fill") { token = null; return new { status = "filled" }; }
                CheckModifiers();
                CheckTarget();
                if (EditorText(editor) != text) Fail("draft-mismatch", "The draft changed before submission. No submit key was sent.");
                var submittedDocument = EditorDocument(editor);
                bool newConversation = documentName == "ChatGPT" && OnlyVisibleComposer(submittedDocument) != null
                    && !HasPostedMessage(submittedDocument, text);
                Inject(submitEvents, mode == "ctrl-enter");
                // Input acceptance is observable; model delivery is not. An
                // uncleared draft must never be retried by sending Enter again.
                verification.Restart();
                bool accepted = false;
                string observation = "draft-present";
                while (verification.ElapsedMilliseconds < 1500) {
                    Thread.Sleep(50);
                    if (GetForegroundWindow() != window || WindowTitle(window) != title) { observation = "window-changed"; break; }
                    if (newConversation) {
                        try {
                            if (NewConversationAccepted(submittedDocument, text)) {
                                token = null;
                                return new { status = "submitted", requiresRebind = true };
                            }
                        } catch (ElementNotAvailableException) { }
                    }
                    try {
                        var currentEditor = SubmittedEditor(submittedDocument);
                        if (currentEditor == null) { observation = "editor-unavailable"; continue; }
                        if (EditorText(currentEditor).Length == 0) accepted = true;
                        if (accepted) {
                            // Codex briefly moves focus during Ctrl+Enter. Wait
                            // for it to settle; focus loss after submitting is
                            // not evidence that the already-sent message failed.
                            editor = currentEditor;
                            runtimeId = currentEditor.GetRuntimeId();
                            try { CheckTarget(); return new { status = "submitted", requiresRebind = false }; }
                            catch (InputFailure) { observation = "focus-changed"; }
                        }
                    } catch (ElementNotAvailableException) { observation = "editor-rebuilding"; }
                    catch (InputFailure error) { observation = error.Code; }
                }
                token = null;
                return new { status = accepted ? "submitted" : "unconfirmed", requiresRebind = true, observation = observation };
            } catch {
                token = null;
                throw;
            }
        }
    }
}
