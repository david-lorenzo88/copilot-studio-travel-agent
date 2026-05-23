#!/usr/bin/env node
/**
 * inject-flow.js
 *
 * Exports the TravelAssistant solution, replaces the CreateDraftQuotation
 * flow definition with the local JSON file, bumps the patch version, and
 * reimports the solution.
 *
 * No pac CLI required — uses Azure CLI (az) for tokens and the Dataverse
 * Web API for export/import.
 *
 * Usage:
 *   node inject-flow.js [--env <orgUrl>] [--solution <uniqueName>] [--dry-run]
 */

'use strict';

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Config ────────────────────────────────────────────────────────────────────

const args       = parseArgs(process.argv.slice(2));
const ORG_URL    = (args['env']      || 'https://premium-us.crm.dynamics.com').replace(/\/$/, '');
const SOLUTION   = args['solution']  || 'TravelAssistant';
const FLOW_NAME  = 'CreateDraftQuotation';
const DRY_RUN    = 'dry-run' in args;

const FLOW_JSON  = path.join(__dirname, 'CreateDraftQuotation-flow.json');
const WORK_DIR   = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-inject-'));

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
      `az account get-access-token --resource "${resource}" --query accessToken -o tsv`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
  } catch {
    console.error(`✗ Cannot get token for ${resource}. Run: az login`);
    process.exit(1);
  }
}

async function dvGet(url, token) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}\n${text}`);
  return text ? JSON.parse(text) : null;
}

/**
 * If export fails due to an unpackaged custom connector, find that connector
 * in the environment's connectors table and add it to the solution, then retry.
 */
async function exportWithConnectorFix(orgUrl, solution, token) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await dvPost(
        `${orgUrl}/api/data/v9.2/ExportSolution`,
        { SolutionName: solution, Managed: false },
        token
      );
    } catch (err) {
      // Extract connector internal id from the error message
      const match = err.message.match(/connector (shared_[^\s"]+)/);
      if (!match) throw err;

      const connectorInternalId = match[1];
      console.log(`  Missing connector: ${connectorInternalId} — adding to solution...`);

      // Find connector record
      const connData = await dvGet(
        `${orgUrl}/api/data/v9.2/connectors?$filter=connectorinternalid eq '${connectorInternalId}'&$select=connectorid,name`,
        token
      );
      if (!connData.value?.length) {
        // Try by name field
        const connData2 = await dvGet(
          `${orgUrl}/api/data/v9.2/connectors?$filter=name eq '${connectorInternalId}'&$select=connectorid,name`,
          token
        );
        if (!connData2.value?.length) {
          throw new Error(`Cannot find connector record for "${connectorInternalId}" in Dataverse. Add it to the solution manually.`);
        }
        connData.value = connData2.value;
      }

      const connectorId = connData.value[0].connectorid;
      console.log(`  Connector record ID: ${connectorId}`);

      // Look up the connector entity's ObjectTypeCode (varies by environment)
      const metaData = await dvGet(
        `${orgUrl}/api/data/v9.2/EntityDefinitions?$filter=LogicalName eq 'connector'&$select=ObjectTypeCode`,
        token
      );
      const componentType = metaData.value?.[0]?.ObjectTypeCode;
      if (!componentType) throw new Error('Could not resolve ObjectTypeCode for connector entity.');
      console.log(`  Connector component type: ${componentType}`);
      await dvPost(
        `${orgUrl}/api/data/v9.2/AddSolutionComponent`,
        {
          ComponentId: connectorId,
          ComponentType: componentType,
          SolutionUniqueName: solution,
          AddRequiredComponents: false,
          DoNotIncludeSubcomponents: false,
        },
        token
      );
      console.log(`  ✓ Connector added to solution. Retrying export (attempt ${attempt + 1})...`);
    }
  }
  throw new Error('Export still failing after connector fixes.');
}

async function dvPost(url, body, token) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}\n${text}`);
  return text ? JSON.parse(text) : null;
}

function bumpVersion(xml) {
  return xml.replace(
    /<Version>(\d+)\.(\d+)\.(\d+)\.(\d+)<\/Version>/,
    (_, a, b, c, d) => `<Version>${a}.${b}.${c}.${parseInt(d, 10) + 1}</Version>`
  );
}

function cleanup() {
  try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('Power Automate Flow Injector (solution export → patch → reimport)');
  console.log('═'.repeat(60));
  console.log(`Environment : ${ORG_URL}`);
  console.log(`Solution    : ${SOLUTION}`);
  console.log(`Flow        : ${FLOW_NAME}`);
  if (DRY_RUN) console.log('Mode        : DRY RUN');
  console.log('');

  // 0. Load our flow JSON
  if (!fs.existsSync(FLOW_JSON)) {
    console.error(`✗ File not found: ${FLOW_JSON}`); process.exit(1);
  }
  const ourFlow = JSON.parse(fs.readFileSync(FLOW_JSON, 'utf8'));
  console.log('✓ Local flow definition loaded');

  // 1. Get token
  const token = getToken(ORG_URL);
  console.log('✓ Access token acquired');

  // 2. Export solution
  console.log(`  Exporting solution "${SOLUTION}" (this may take 10-30 s)...`);
  const exportResult = await exportWithConnectorFix(ORG_URL, SOLUTION, token);
  const zipBuf = Buffer.from(exportResult.ExportSolutionFile, 'base64');
  const zipPath = path.join(WORK_DIR, 'solution.zip');
  fs.writeFileSync(zipPath, zipBuf);
  console.log(`✓ Solution exported (${(zipBuf.length / 1024).toFixed(0)} KB)`);

  // 3. Unzip
  const extractDir = path.join(WORK_DIR, 'src');
  fs.mkdirSync(extractDir);
  execSync(`unzip -q "${zipPath}" -d "${extractDir}"`);
  console.log('✓ Solution unzipped');

  // 4. Locate the flow file inside Workflows/
  const workflowsDir = path.join(extractDir, 'Workflows');
  if (!fs.existsSync(workflowsDir)) {
    console.error('✗ No Workflows/ folder found in the solution package.');
    process.exit(1);
  }

  const allFiles = fs.readdirSync(workflowsDir);
  console.log(`  Workflow files in package: ${allFiles.join(', ')}`);

  const flowFile = allFiles.find(f =>
    f.toLowerCase().replace(/[\s_-]/g, '').includes('createdraftquotation')
  );

  if (!flowFile) {
    console.error(`\n✗ Could not find a "${FLOW_NAME}" file in Workflows/.`);
    console.error('  Available files:', allFiles.join(', '));
    process.exit(1);
  }
  console.log(`✓ Found flow file: ${flowFile}`);

  // 5. Patch the flow file
  const flowFilePath = path.join(workflowsDir, flowFile);
  const raw = fs.readFileSync(flowFilePath, 'utf8');

  let patched;
  if (flowFile.endsWith('.json')) {
    // Modern solution format: the file IS a Power Automate flow JSON.
    // Preserve solution metadata (workflowid, name, etc.) but replace
    // definition, connectionReferences, and parameters from our file.
    const existing = JSON.parse(raw);

    existing.properties = existing.properties || {};
    existing.properties.definition          = ourFlow.definition;
    existing.properties.connectionReferences = ourFlow.connectionReferences || {};
    existing.properties.parameters          = ourFlow.parameters || {};

    // Carry over the trigger description if set in our file
    if (ourFlow.definition?.triggers?.manual?.metadata?.description) {
      existing.properties.definition.triggers.manual.metadata.description =
        ourFlow.definition.triggers.manual.metadata.description;
    }

    patched = JSON.stringify(existing, null, 2);

  } else if (flowFile.endsWith('.xml') || flowFile.endsWith('.xaml')) {
    // Legacy XML format: inject our definition into the clientdata attribute/element.
    // The definition is stored as an escaped JSON string inside <clientdata>.
    const clientDataJson = JSON.stringify({
      properties: {
        definition:           ourFlow.definition,
        connectionReferences: ourFlow.connectionReferences || {},
        parameters:           ourFlow.parameters || {},
      },
    });
    const escapedJson = clientDataJson
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    if (!raw.includes('<clientdata')) {
      console.error('✗ Could not locate <clientdata> in the XML workflow file.');
      process.exit(1);
    }
    patched = raw.replace(
      /<clientdata>.*?<\/clientdata>/s,
      `<clientdata>${escapedJson}</clientdata>`
    );

  } else {
    console.error(`✗ Unsupported flow file format: ${flowFile}`);
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log('✓ [DRY RUN] Patched flow content ready — skipping write, version bump, and reimport.');
    console.log('\nDry run complete. No changes were made.\n');
    return;
  }

  fs.writeFileSync(flowFilePath, patched, 'utf8');
  console.log('✓ Flow definition injected into solution package');

  // 6. Bump solution version in solution.xml
  const solutionXmlPath = path.join(extractDir, 'solution.xml');
  const solutionXml     = fs.readFileSync(solutionXmlPath, 'utf8');
  const bumped          = bumpVersion(solutionXml);

  const oldVer = (solutionXml.match(/<Version>(.*?)<\/Version>/) || [])[1] || '?';
  const newVer = (bumped.match(/<Version>(.*?)<\/Version>/)       || [])[1] || '?';
  fs.writeFileSync(solutionXmlPath, bumped, 'utf8');
  console.log(`✓ Solution version bumped: ${oldVer} → ${newVer}`);

  // 7. Rezip
  const newZipPath = path.join(WORK_DIR, 'solution_patched.zip');
  execSync(`cd "${extractDir}" && zip -r "${newZipPath}" . -q`);
  console.log(`✓ Repackaged (${(fs.statSync(newZipPath).size / 1024).toFixed(0)} KB)`);

  // 8. Import
  console.log(`  Importing patched solution (this may take 20-60 s)...`);
  // Refresh token — export + zip can take a while
  const freshToken = getToken(ORG_URL);
  const newZipB64  = fs.readFileSync(newZipPath).toString('base64');

  await dvPost(
    `${ORG_URL}/api/data/v9.2/ImportSolution`,
    {
      CustomizationFile:               newZipB64,
      OverwriteUnmanagedCustomizations: true,
      PublishWorkflows:                 true,
      ConvertToManaged:                 false,
      SkipProductUpdateDependencies:    false,
      HoldingSolution:                  false,
    },
    freshToken
  );

  console.log('');
  console.log('═'.repeat(60));
  console.log(`✓ "${FLOW_NAME}" successfully injected into "${SOLUTION}" (v${newVer}).`);
  console.log('  Open in Power Automate to wire the Dataverse connection reference.');
  console.log('');
}

main().catch(err => {
  console.error('\n✗ Error:', err.message || err);
  process.exit(1);
});
