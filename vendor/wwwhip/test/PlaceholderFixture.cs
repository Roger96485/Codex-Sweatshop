// Test-only: reads editors exclusively inside the supplied Electron fixture.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using OpenWhip;
public static class PlaceholderFixture {
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
    [MTAThread] public static void Main(string[] args) {
        var handle=new IntPtr(Int64.Parse(args[0]));uint pid;GetWindowThreadProcessId(handle,out pid);
        if(pid!=UInt32.Parse(args[1]))throw new Exception("Only the owned fixture window may be inspected.");
        var window=AutomationElement.FromHandle(handle);var rows=new List<object>();
        var condition=new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Edit);
        AutomationElementCollection edits=null;
        for(int retry=0;retry<40;retry++){edits=window.FindAll(TreeScope.Descendants,condition);if(edits.Count>0)break;System.Threading.Thread.Sleep(100);}
        if(edits.Count==0)throw new Exception("The fixture did not expose its editable controls: "+window.Current.Name);
        foreach(AutomationElement edit in edits) {
            if(!CodexInput.IsComposerName(edit.Current.Name))continue;
            object valuePattern,textPattern;string raw=null;var leaves=new List<object>();
            if(edit.TryGetCurrentPattern(ValuePattern.Pattern,out valuePattern))raw=((ValuePattern)valuePattern).Current.Value;
            if(edit.TryGetCurrentPattern(TextPattern.Pattern,out textPattern)) {
                var pattern=(TextPattern)textPattern;
                foreach(AutomationElement child in edit.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Text))) {
                    var parent=TreeWalker.RawViewWalker.GetParent(child);var range=pattern.RangeFromChild(child);
                    var readonlyValue=range.GetAttributeValue(TextPattern.IsReadOnlyAttribute);
                    var ancestors=new List<object>();
                    for(var a=child;a!=null&&!a.Equals(edit)&&ancestors.Count<5;a=TreeWalker.RawViewWalker.GetParent(a))
                        ancestors.Add(new {name=a.Current.Name,type=a.Current.ControlType.ProgrammaticName,className=a.Current.ClassName,
                            content=a.Current.IsContentElement,control=a.Current.IsControlElement});
                    leaves.Add(new {name=child.Current.Name,className=child.Current.ClassName,parentClass=parent==null?"":parent.Current.ClassName,
                        readOnly=readonlyValue.ToString(),rangeText=range.GetText(4096),ancestors=ancestors});
                }
            }
            rows.Add(new {id=edit.Current.AutomationId,name=edit.Current.Name,raw=raw,effective=CodexInput.EditorText(edit),leaves=leaves});
        }
        Console.OutputEncoding=new System.Text.UTF8Encoding(false);Console.WriteLine(new JavaScriptSerializer().Serialize(rows));
    }
}
