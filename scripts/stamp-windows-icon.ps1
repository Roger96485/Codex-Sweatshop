param(
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$Icon
)
$ErrorActionPreference = 'Stop'
$sweatshopBuildRoot = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $PSScriptRoot) 'dist\Codex-Sweatshop')) + [IO.Path]::DirectorySeparatorChar
$sweatshopExe = (Resolve-Path -LiteralPath $Executable).Path
$sweatshopIcon = (Resolve-Path -LiteralPath $Icon).Path
if (-not $sweatshopExe.StartsWith($sweatshopBuildRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($sweatshopExe) -ne '.exe') {
  throw 'Only an executable inside the named Sweatshop build directory can be branded.'
}
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class SweatshopIconResources {
  delegate bool NameCallback(IntPtr module, IntPtr type, IntPtr name, IntPtr context);
  delegate bool LanguageCallback(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr context);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
  [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr module);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool EnumResourceNames(IntPtr module, IntPtr type, NameCallback callback, IntPtr context);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, LanguageCallback callback, IntPtr context);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr BeginUpdateResource(string path, bool deleteExisting);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool EndUpdateResource(IntPtr update, bool discard);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern void SHChangeNotify(uint change, uint flags, string first, IntPtr second);
  sealed class Key { public int Type; public int Id; public string Name; public ushort Language; }
  static void Check(bool success) { if(!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static void Change(IntPtr update, Key key, byte[] data) {
    IntPtr name=key.Name==null ? new IntPtr(key.Id) : Marshal.StringToHGlobalUni(key.Name);
    try { Check(UpdateResource(update,new IntPtr(key.Type),name,key.Language,data,data==null?0:(uint)data.Length)); }
    finally { if(key.Name!=null)Marshal.FreeHGlobal(name); }
  }
  public static int Apply(string executable, string icon) {
    byte[] bytes=File.ReadAllBytes(icon);
    if(bytes.Length<6 || BitConverter.ToUInt16(bytes,0)!=0 || BitConverter.ToUInt16(bytes,2)!=1)throw new InvalidDataException("Invalid ICO header");
    int count=BitConverter.ToUInt16(bytes,4);
    if(count<1 || count>32 || bytes.Length<6+16*count)throw new InvalidDataException("Invalid ICO directory");
    var images=new List<byte[]>();
    byte[] group=new byte[6+14*count];Array.Copy(bytes,group,6);
    for(int i=0;i<count;i++) {
      int entry=6+16*i;uint length=BitConverter.ToUInt32(bytes,entry+8),offset=BitConverter.ToUInt32(bytes,entry+12);
      if(length==0 || offset<6+16*count || (ulong)offset+length>(ulong)bytes.Length)throw new InvalidDataException("Invalid ICO image range");
      byte[] image=new byte[length];Array.Copy(bytes,(long)offset,image,0,(long)length);images.Add(image);
      Array.Copy(bytes,entry,group,6+14*i,12);Array.Copy(BitConverter.GetBytes((ushort)(i+1)),0,group,6+14*i+12,2);
    }
    var obsolete=new List<Key>();
    IntPtr module=LoadLibraryEx(executable,IntPtr.Zero,0x22);
    if(module==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      foreach(int resourceType in new int[]{3,14}) {
        NameCallback names=(m,t,n,c)=>{
          bool numeric=((ulong)n.ToInt64()>>16)==0;
          int id=numeric?n.ToInt32():0;string name=numeric?null:Marshal.PtrToStringUni(n);
          LanguageCallback languages=(lm,lt,ln,language,lc)=>{obsolete.Add(new Key{Type=resourceType,Id=id,Name=name,Language=language});return true;};
          Check(EnumResourceLanguages(m,t,n,languages,IntPtr.Zero));return true;
        };
        if(!EnumResourceNames(module,new IntPtr(resourceType),names,IntPtr.Zero)) {
          int error=Marshal.GetLastWin32Error();if(error!=1813 && error!=1812)throw new Win32Exception(error);
        }
      }
    } finally {FreeLibrary(module);}
    IntPtr update=BeginUpdateResource(executable,false);
    if(update==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      // Replace all old icon groups, retaining manifests, version info and code.
      foreach(Key key in obsolete)Change(update,key,null);
      for(int i=0;i<count;i++)Change(update,new Key{Type=3,Id=i+1,Language=0},images[i]);
      Change(update,new Key{Type=14,Id=101,Language=0},group);
      Check(EndUpdateResource(update,false));update=IntPtr.Zero;
    } finally {if(update!=IntPtr.Zero)EndUpdateResource(update,true);}
    SHChangeNotify(0x2000,0x0005,executable,IntPtr.Zero);
    return count;
  }
}
'@
$sweatshopFrames = [SweatshopIconResources]::Apply($sweatshopExe, $sweatshopIcon)
Write-Host ("Branded {0}: {1} icon sizes" -f [IO.Path]::GetFileName($sweatshopExe), $sweatshopFrames)
