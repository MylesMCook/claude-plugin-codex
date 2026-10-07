import {test} from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
test("bounded Windows PowerShell startup trace", t=>{
 if(process.platform!=="win32"){t.skip();return;}
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"claude-acl-diagnostic-"));
 try {
 const tools=path.join(process.env.SystemRoot,"System32");
 for(const d of ["AppData/Roaming","AppData/Local"]) fs.mkdirSync(path.join(root,d),{recursive:true});
 const script=`$ErrorActionPreference='Stop'; [Console]::WriteLine('startup'); [AppContext]::SetSwitch('Switch.System.IO.UseLegacyPathHandling',$false); [Console]::WriteLine('switch'); $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; [Console]::WriteLine('identity'); $acl=New-Object System.Security.AccessControl.DirectorySecurity; [Console]::WriteLine('constructed'); $sections=[System.Security.AccessControl.AccessControlSections]::Access; $acl.SetSecurityDescriptorSddlForm(('D:P(A;OICI;FA;;;' + $sid + ')(A;OICI;FA;;;SY)'),$sections); [Console]::WriteLine('sddl'); [System.IO.Directory]::SetAccessControl($env:CLAUDE_STATE_ACL_PATH,$acl); [Console]::WriteLine('applied');`;
 const env={SystemRoot:process.env.SystemRoot,windir:process.env.SystemRoot,SystemDrive:path.parse(process.env.SystemRoot).root.replace(/[\\/]$/, ""),PATH:tools,USERPROFILE:root,APPDATA:path.join(root,"AppData/Roaming"),LOCALAPPDATA:path.join(root,"AppData/Local"),TEMP:root,TMP:root,PSModulePath:path.join(tools,"WindowsPowerShell/v1.0/Modules"),CLAUDE_STATE_ACL_PATH:path.toNamespacedPath(root)};
 const r=spawnSync(path.join(tools,"WindowsPowerShell/v1.0/powershell.exe"),["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(script,"utf16le").toString("base64")],{env,timeout:10000,encoding:"utf8",windowsHide:true});
 console.log(JSON.stringify({code:r.error?.code,status:r.status,stdout:r.stdout,stderr:r.stderr}));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
