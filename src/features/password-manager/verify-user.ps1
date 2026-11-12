param([switch]$CheckAvailability)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
    $resultType = [Windows.Security.Credentials.UI.UserConsentVerificationResult, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    if ($CheckAvailability) {
        $resultType = [Windows.Security.Credentials.UI.UserConsentVerifierAvailability, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
        $operation = [Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()
    } else {
        $operation = [Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('Verify your identity to view or edit BOBO saved passwords.')
    }
    $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
    if ($CheckAvailability) {
        if ($task.Wait(5000)) { [Console]::Write($task.Result.ToString()); exit 0 }
        exit 1
    }
    if ($task.Wait(55000) -and $task.Result -eq [Windows.Security.Credentials.UI.UserConsentVerificationResult]::Verified) {
        [Console]::Write('BOBO_VERIFIED')
        exit 0
    }
} catch {
    if ($CheckAvailability) { [Console]::Write('Unavailable: ' + $_.Exception.GetType().Name) }
}
exit 1
