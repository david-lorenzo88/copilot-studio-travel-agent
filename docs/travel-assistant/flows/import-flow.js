#!/usr/bin/env node
/**
 * import-flow.js
 *
 * Imports CreateDraftQuotation-flow.json into a Dataverse environment
 * and adds it to the TravelAssistant solution.
 *
 * Prerequisites:
 *   - Node.js 18+
 *   - Azure CLI (az) installed and logged in  (`az login`)
 *   - The logged-in account must have System Customizer or System Administrator
 *     role in the target Dataverse environment.
 *
 * Usage:
 *   node import-flow.js [--env <orgUrl>] [--solution <uniqueName>] [--dry-run]
 *
 * Defaults:
 *   --env       https://premium-us.crm.dynamics.com
 *   --solution  TravelAssistant
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Configuration ─────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const ORG_URL      = (args['env']      || 'https://premium-us.crm.dynamics.com').replace(/\/$/, '');
const SOLUTION     = args['solution']  || 'TravelAssistant';
const FLOW_NAME    = 'CreateDraftQuotation';
const FLOW_UNIQUE  = 'tra_CreateDraftQuotation';
const DRY_RUN      = 'dry-run' in args;

const FLOW_JSON_PATH = path.join(__dirname, 'CreateDraftQuotation-flow.json');

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return out;
}

function getToken(resource) {
  try {
    return execSync(
      `az account get-access-token --resource ${resource} --query accessToken -o tsv`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
  } catch (e) {
    console.error(`\n✗ Could not acquire token for ${resource}.`);
    console.error('  Make sure you are logged in: az login\n');
    process.exit(1);
  }
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}\n${text}`);
  }
  return text ? JSON.parse(text) : null;
}

function dvHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'OData-MaxVersion': '4.0',
    'OData-Version': '4.0',
    Accept: 'application/json',
    Prefer: 'return=representation',
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('Power Automate Flow Importer');
  console.log('═'.repeat(50));
  console.log(`Environment : ${ORG_URL}`);
  console.log(`Solution    : ${SOLUTION}`);
  console.log(`Flow        : ${FLOW_NAME}`);
  if (DRY_RUN) console.log('Mode        : DRY RUN (no changes will be made)');
  console.log('');

  // 1. Read flow JSON
  if (!fs.existsSync(FLOW_JSON_PATH)) {
    console.error(`✗ Flow file not found: ${FLOW_JSON_PATH}`);
    process.exit(1);
  }
  const flowJson = JSON.parse(fs.readFileSync(FLOW_JSON_PATH, 'utf8'));
  console.log('✓ Flow definition loaded');

  // 2. Get tokens
  console.log('  Acquiring access tokens via Azure CLI...');
  const paToken  = getToken('https://service.flow.microsoft.com');
  const dvToken  = getToken(ORG_URL);
  console.log('✓ Tokens acquired');

  // 3. Discover environment ID from PA Management API
  console.log('  Discovering Power Automate environment ID...');
  const envsData = await apiFetch(
    'https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple/environments?api-version=2016-11-01',
    { headers: { Authorization: `Bearer ${paToken}`, Accept: 'application/json' } }
  );

  const orgUrlNorm = ORG_URL.toLowerCase().replace(/\/$/, '');
  const env = (envsData.value || []).find(e => {
    const instanceUrl = (
      e.properties?.linkedEnvironmentMetadata?.instanceUrl || ''
    ).toLowerCase().replace(/\/$/, '');
    return instanceUrl === orgUrlNorm;
  });

  if (!env) {
    console.error(`\n✗ No Power Automate environment found matching:\n  ${ORG_URL}`);
    console.error('\n  Available environments:');
    (envsData.value || []).forEach(e =>
      console.error(`    • ${e.properties?.displayName}  →  ${e.properties?.linkedEnvironmentMetadata?.instanceUrl || 'no URL'}`)
    );
    process.exit(1);
  }
  const envId = env.name;
  console.log(`✓ Environment found: ${env.properties?.displayName} (${envId})`);

  // 4. Check if flow already exists
  console.log(`  Checking for existing flow "${FLOW_NAME}"...`);
  const existingFlows = await apiFetch(
    `${ORG_URL}/api/data/v9.2/workflows?$filter=uniquename eq '${FLOW_UNIQUE}' and category eq 5&$select=workflowid,name,statecode`,
    { headers: dvHeaders(dvToken) }
  );

  let workflowId = null;

  if (existingFlows.value && existingFlows.value.length > 0) {
    workflowId = existingFlows.value[0].workflowid;
    console.log(`  Flow already exists (id: ${workflowId}), skipping creation.`);
  } else {
    // 5. Create the flow via Power Automate Management API
    const flowBody = {
      properties: {
        displayName: FLOW_NAME,
        definition: flowJson.definition,
        connectionReferences: flowJson.connectionReferences || {},
        parameters: flowJson.parameters || {},
      },
    };

    // The PA Management API for flow creation does not accept solution-layer
    // connection reference shapes. Pass empty refs; the user will wire them
    // in the designer after import.
    flowBody.properties.connectionReferences = {};

    // Strip $authentication parameter and the 'authentication' input from every
    // OpenApiConnection action — these are solution-layer constructs rejected by
    // the Management API.
    delete defForApi.parameters?.$authentication;
    function stripAuth(actions) {
      for (const action of Object.values(actions || {})) {
        if (action.inputs?.authentication) delete action.inputs.authentication;
        if (action.actions) stripAuth(action.actions);
        if (action.else?.actions) stripAuth(action.else.actions);
      }
    }
    stripAuth(defForApi.actions);
    flowBody.properties.definition = defForApi;
    // for Copilot Studio flows; normalise before posting.
    const defForApi = JSON.parse(JSON.stringify(flowBody.properties.definition));
    if (defForApi.triggers?.manual?.kind === 'PowerVirtualAgents') {
      defForApi.triggers.manual.kind = 'Button';
    }
    for (const action of Object.values(defForApi.actions || {})) {
      if (action.kind === 'PowerVirtualAgents') action.kind = 'Button';
    }
    flowBody.properties.definition = defForApi;

    if (DRY_RUN) {
      console.log('✓ [DRY RUN] Would POST flow to PA Management API');
      console.log('  Payload preview:');
      console.log('  ' + JSON.stringify(flowBody.properties.definition.$schema));
    } else {
      console.log(`  Creating flow via Power Automate API (env: ${envId})...`);
      const created = await apiFetch(
        `https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple/environments/${envId}/flows?api-version=2016-11-01`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${paToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(flowBody),
        }
      );
      // The PA API returns the flow's internal name (GUID)
      const flowInternalName = created.name;
      console.log(`✓ Flow created (internal name: ${flowInternalName})`);

      // 5b. Resolve the workflow record ID in Dataverse using the PA flow GUID
      console.log('  Resolving Dataverse workflow record...');
      const resolved = await apiFetch(
        `${ORG_URL}/api/data/v9.2/workflows?$filter=workflowid eq ${flowInternalName} or name eq '${flowInternalName}'&$select=workflowid,name`,
        { headers: dvHeaders(dvToken) }
      );

      if (resolved.value && resolved.value.length > 0) {
        workflowId = resolved.value[0].workflowid;
      } else {
        // Fallback: search by display name
        const byName = await apiFetch(
          `${ORG_URL}/api/data/v9.2/workflows?$filter=name eq '${FLOW_NAME}' and category eq 5&$select=workflowid,name&$orderby=createdon desc&$top=1`,
          { headers: dvHeaders(dvToken) }
        );
        workflowId = byName.value?.[0]?.workflowid;
      }

      if (!workflowId) {
        console.error('✗ Could not resolve workflow record in Dataverse. Add it to the solution manually.');
        process.exit(1);
      }
      console.log(`✓ Workflow record ID: ${workflowId}`);
    }
  }

  if (DRY_RUN) {
    console.log(`\n✓ [DRY RUN] Would add workflow ${workflowId || '<new>'} to solution "${SOLUTION}"`);
    console.log('\nDry run complete. No changes were made.\n');
    return;
  }

  if (!workflowId) {
    console.error('✗ No workflow ID available to add to solution.');
    process.exit(1);
  }

  // 6. Resolve solution ID
  console.log(`  Looking up solution "${SOLUTION}"...`);
  const solData = await apiFetch(
    `${ORG_URL}/api/data/v9.2/solutions?$filter=uniquename eq '${SOLUTION}'&$select=solutionid,friendlyname`,
    { headers: dvHeaders(dvToken) }
  );

  if (!solData.value || solData.value.length === 0) {
    console.error(`✗ Solution "${SOLUTION}" not found in ${ORG_URL}`);
    process.exit(1);
  }
  console.log(`✓ Solution: ${solData.value[0].friendlyname} (${solData.value[0].solutionid})`);

  // 7. Add workflow to solution (component type 29 = Workflow)
  console.log(`  Adding flow to solution "${SOLUTION}"...`);
  await apiFetch(
    `${ORG_URL}/api/data/v9.2/AddSolutionComponent`,
    {
      method: 'POST',
      headers: dvHeaders(dvToken),
      body: JSON.stringify({
        ComponentId: workflowId,
        ComponentType: 29,
        SolutionUniqueName: SOLUTION,
        AddRequiredComponents: false,
        DoNotIncludeSubcomponents: false,
        IncludedComponentSettingsValues: null,
      }),
    }
  );

  console.log('');
  console.log('═'.repeat(50));
  console.log(`✓ "${FLOW_NAME}" imported into solution "${SOLUTION}" successfully.`);
  console.log(`  Open the flow at:`);
  console.log(`  https://make.powerautomate.com/environments/${envId}/solutions/TravelAssistant`);
  console.log('');
}

main().catch(err => {
  console.error('\n✗ Unexpected error:', err.message || err);
  process.exit(1);
});
