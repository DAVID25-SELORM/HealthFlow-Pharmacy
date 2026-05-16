# NSSM Windows x64

The HealthFlow offline deployment package includes the Windows x64 NSSM binary here:

```text
local-branch-server/deployment/windows/nssm/win64/nssm.exe
```

Bundled binary:

```text
Version: NSSM 2.24
SHA-256: F689EE9AF94B00E9E3F0BB072B34CAAF207F32DCB4F5782FC9CA351DF9A06C97
Source:  https://nssm.cc/release/nssm-2.24.zip
```

`scripts/install-service.ps1` checks this folder first, then copies NSSM into:

```text
C:\HealthFlowPharmacy\nssm\nssm.exe
```

If the binary is missing during installation, the installer attempts to download NSSM 2.24 automatically from the official NSSM release URL and installs the x64 binary into the same folder.
