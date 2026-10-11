PS C:\WINDOWS\system32> $token = 'DUCK_DNS_TOKEN_HERE'
PS C:\WINDOWS\system32> $secureToken = ConvertTo-SecureString $token -AsPlainText -Force
PS C:\WINDOWS\system32> $pArgs = @{
>>     DuckToken  = $secureToken
>>     DuckDomain = 'bearbones'
>> }
PS C:\WINDOWS\system32> New-PACertificate 'bearbones.duckdns.org' -Plugin DuckDNS -PluginArgs $pArgs -AcceptTOS

---------------------------------------------------------------------------------------------------------------

C:\Scripts\renew-cert.ps1

```
Import-Module Posh-ACME
Submit-Renewal -Verbose
```

---------------------------------------------------------------------------------------------------------------

$taskName = "Posh-ACME Renewal"
$action   = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\Scripts\renew-cert.ps1"
$trigger  = New-ScheduledTaskTrigger -Daily -At 3:00AM

# Run under your current logged-in user account
$currentUser = "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Force