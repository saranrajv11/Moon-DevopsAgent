#!/usr/bin/env bash
# Deploy Moon to a Salesforce org, in dependency order.
#   ./deploy.sh <org-alias>
set -uo pipefail
ORG="${1:-moon}"
cd "$(dirname "$0")/sf-metadata"

step() {
  local label="$1"; shift
  printf "  %-34s" "$label"
  local out
  out=$(sf project deploy start --target-org "$ORG" --ignore-conflicts --wait 20 --json "$@" 2>/dev/null)
  python3 - "$out" <<'PY'
import json, sys
raw = sys.argv[1]; i = raw.find("{")
try:
    r = json.loads(raw[i:]).get("result", {})
    ok = r.get("status") == "Succeeded"
    print(f"{'OK  ' if ok else 'FAIL'} {r.get('numberComponentsDeployed',0)}/{r.get('numberComponentsTotal',0)}")
    if not ok:
        f = r.get("details", {}).get("componentFailures", [])
        f = f if isinstance(f, list) else [f]
        for x in f[:6]:
            print(f"        - {x.get('fullName')}: {(x.get('problem') or '')[:120]}")
        if r.get("errorMessage"): print(f"        ! {r['errorMessage'][:140]}")
except Exception:
    print("FAIL (could not parse response)")
PY
}

echo "Deploying Moon to '$ORG'"
echo
step "objects + fields"  --source-dir force-app/main/default/objects
step "custom metadata"   --source-dir force-app/main/default/customMetadata
step "apex controller"   --source-dir force-app/main/default/classes
step "lightning component" --source-dir force-app/main/default/lwc
step "app page"          --source-dir force-app/main/default/flexipages
step "tabs"              --source-dir force-app/main/default/tabs
step "application"       --source-dir force-app/main/default/applications
step "permission sets"   --source-dir force-app/main/default/permissionsets

echo
echo "Verifying fields actually landed (a Succeeded deploy is not proof):"
for obj in DevOps_User_Story__c DevOps_Commit__c DevOps_Pull_Request__c \
           DevOps_Deployment__c DevOps_Pipeline_Run__c DevOps_Audit_Log__c \
           DevOps_Deployment_Approval__c; do
  exp=$(ls force-app/main/default/objects/$obj/fields/*.xml 2>/dev/null | wc -l | tr -d ' ')
  act=$(sf sobject describe --target-org "$ORG" --sobject $obj 2>/dev/null \
    | python3 -c "import json,sys;d=sys.stdin.read();i=d.find('{');print(len([f for f in json.loads(d[i:])['fields'] if f['custom']]))" 2>/dev/null || echo 0)
  if [ "$exp" = "$act" ]; then mark="OK"; else mark="<-- $((exp-act)) MISSING"; fi
  printf "  %-32s %s/%s %s\n" "$obj" "$act" "$exp" "$mark"
done
