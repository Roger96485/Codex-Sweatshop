using System;
using System.Runtime.InteropServices;
using OpenWhip;

public static class NativeTests {
    private static int count;
    private static void Check(bool value, string name) {
        if (!value) throw new Exception(name);
        count++;
    }
    private static void Reject(Action action, string name) {
        try { action(); } catch (InputFailure) { count++; return; }
        throw new Exception(name);
    }
    public static void Main() {
        Check(CodexInput.InputSize() == (IntPtr.Size == 8 ? 40 : 28), "Win32 INPUT layout");
        Check(Marshal.OffsetOf(typeof(CodexInput.INPUT), "value").ToInt32() == (IntPtr.Size == 8 ? 8 : 4), "union alignment");
        Check(CodexInput.IsCodexExecutable(@"C:\Program Files\WindowsApps\OpenAI.Codex_26.915_x64__publisher\app\ChatGPT.exe"), "modern Desktop");
        Check(CodexInput.IsCodexExecutable(@"C:\Apps\Codex\Codex.exe"), "classic Desktop");
        Check(!CodexInput.IsCodexExecutable(@"C:\Apps\Codex\bin\hash\codex.exe"), "CLI is excluded");
        Check(!CodexInput.IsCodexExecutable(@"C:\Apps\ChatGPT\ChatGPT.exe"), "generic ChatGPT is excluded");
        Check(!CodexInput.IsCodexExecutable(@"C:\Apps\Codex\other.exe"), "unrelated executable");
        Check(CodexInput.IsComposerName("随心输入"), "simplified Chinese UI");
        Check(CodexInput.IsComposerName("向 Codex 下达任意指令\u200b"), "zero-width placeholder suffix");
        Check(CodexInput.IsComposerName("想做什麼都可以"), "traditional Chinese UI");
        Check(!CodexInput.IsComposerName("Search chats"), "search field");
        Check(!CodexInput.IsComposerName("Terminal"), "terminal field");
        Check(!CodexInput.IsComposerName("Ask ChatGPT"), "Chat product composer");
        Check(CodexInput.IsComposerName("给 ChatGPT 发消息"), "Desktop ChatGPT composer");
        Check(CodexInput.IsComposerName("使用 ChatGPT Work"), "Desktop Work composer");
        var events = CodexInput.TextInputs("中🙂A");
        Check(events.Length == 8, "UTF-16 including emoji surrogate pair");
        Check(events[0].value.keyboard.scan == '中', "Chinese code unit");
        Check(Char.IsHighSurrogate((char)events[2].value.keyboard.scan), "high surrogate");
        Check(Char.IsLowSurrogate((char)events[4].value.keyboard.scan), "low surrogate");
        for (int i = 0; i < events.Length; i++) {
            Check(events[i].type == 1 && events[i].value.keyboard.vk == 0, "Unicode keyboard input");
            Check(events[i].value.keyboard.flags == (i % 2 == 0 ? 4u : 6u), "balanced key-up");
        }
        Reject(() => CodexInput.TextInputs("one\ntwo"), "newline rejected");
        Reject(() => CodexInput.TextInputs("\u001b"), "control key rejected");
        Reject(() => CodexInput.TextInputs("\ud800"), "unpaired high surrogate");
        Reject(() => CodexInput.TextInputs("\udc00"), "unpaired low surrogate");
        Reject(() => CodexInput.TextInputs(""), "empty text");
        Reject(() => CodexInput.TextInputs(new String('x', 2001)), "length limit");
        Check(CodexInput.SubmitInputs("fill").Length == 0, "fill has no submit key");
        var enter = CodexInput.SubmitInputs("enter");
        Check(enter.Length == 2 && enter[0].value.keyboard.vk == 13 && enter[1].value.keyboard.flags == 2, "Enter only, no interrupt");
        var ctrlEnter = CodexInput.SubmitInputs("ctrl-enter");
        Check(ctrlEnter.Length == 4 && ctrlEnter[0].value.keyboard.vk == 17 && ctrlEnter[3].value.keyboard.flags == 2, "Ctrl+Enter release");
        Reject(() => CodexInput.SubmitInputs("ctrl-c"), "unsupported submit mode");
        Reject(() => CodexInput.Send("unbound", "FASTER", "enter"), "unbound send rejected before input");
        Console.WriteLine("Native checks passed: " + count + "; no desktop input was sent.");
    }
}
