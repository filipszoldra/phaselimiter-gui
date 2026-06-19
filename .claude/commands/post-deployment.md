# Post-deployment monitor skill

After deploying a new build of the phaselimiter Cloud Run server, this skill:
1. Waits for the latest `build-server` GitHub Actions run to complete
2. Calls `/api/debug` and `/api/reference` on the deployed server
3. Reports results against the 6 success criteria

Cloud Run URL: `https://phaselimiter-x5t4oa4mza-lm.a.run.app`
GitHub repo: `filipszoldra/phaselimiter-gui`
Workflow: `build-server.yml`

## Success criteria

1. **Mastering OK** — upload pliku WAV -> kolejka "succeeded" -> Download button -> poprawny WAV
2. **Audio analyzer OK** — analiza zwraca 9 pasm per-band -> wykres EQ renderuje się
3. **Pelna analiza** — widoczne: krzywa LUFS w czasie, spektrogram, metryki (LUFS, LRA, TruePeak)
4. **Section play** — przyciski Play przy sekcjach dzialaja w przegladarce
5. **Czas** — pelna analiza 3:37 WAV konczy sie w <90s
6. **Brak bledow JS** — konsola przegladarki bez nowych uncaught errors

## Steps to execute

Run the following bash commands in sequence (wait for output of each before proceeding):

```bash
# Step 1: Get latest build-server run ID
gh run list --repo filipszoldra/phaselimiter-gui --workflow build-server.yml --limit 1 --json databaseId,status,conclusion,createdAt --jq '.[0]'
```

```bash
# Step 2: Wait for it to complete (poll every 30s, up to 20 minutes)
RUN_ID=$(gh run list --repo filipszoldra/phaselimiter-gui --workflow build-server.yml --limit 1 --json databaseId --jq '.[0].databaseId')
echo "Watching run $RUN_ID..."
gh run watch "$RUN_ID" --repo filipszoldra/phaselimiter-gui --exit-status
```

```bash
# Step 3: Check CI result
gh run view "$RUN_ID" --repo filipszoldra/phaselimiter-gui --json conclusion,status --jq '"CI result: \(.conclusion)"'
```

```bash
# Step 4: Test /api/debug (engine health)
curl -s --max-time 30 "https://phaselimiter-x5t4oa4mza-lm.a.run.app/api/debug" 2>&1 | head -80
```

```bash
# Step 5: Test /api/reference (resource files present)
curl -s --max-time 15 "https://phaselimiter-x5t4oa4mza-lm.a.run.app/api/reference" 2>&1 | python3 -c "import sys,json; d=json.load(sys.stdin); print('bands:', len(d.get('bands',[])), '| keys:', list(d.keys())[:5])" 2>&1 || echo "FAIL: /api/reference not JSON or error"
```

## Interpretation guide

From `/api/debug` output, check:
- `phase_limiter (no args, exit=<nil>)` -> engine starts (nil = OK, exit status 1 = flag parsing error)
- `ldd phase_limiter` -> no "not found" lines -> all .so dependencies resolved
- `ldd audio_analyzer` -> same check
- `Ipp initialized` in phase_limiter output -> IPP loaded correctly
- `audio_analyzer (no args)` output -> should show usage/help, not "command not found"

## Report format

After running all checks, report:

```
=== POST-DEPLOYMENT REPORT ===
CI: [PASSED/FAILED]
/api/debug:
  - phase_limiter exit: [exit code]
  - IPP init: [YES/NO]
  - ldd errors: [none / list]
  - audio_analyzer exit: [exit code]
/api/reference: [OK (N bands) / FAIL]

Success criteria met:
  1. Mastering: [UNKNOWN - needs manual test]
  2. Audio analyzer: [OK/FAIL based on /api/debug]
  3. Full analysis: [UNKNOWN - needs manual test]
  4. Section play: [UNKNOWN - needs manual test]
  5. Speed: [UNKNOWN - needs manual test]
  6. JS errors: [UNKNOWN - needs manual test]

Next action: [DONE / spawn subagent with errors: ...]
```