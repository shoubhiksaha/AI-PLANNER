#!/usr/bin/env node
/**
 * AI Planner — derive the STAGING Firebase config from firebase.json (production).
 *
 *   node scripts/ci/firebase-config.js staging   # writes firebase.staging.json (gitignored)
 *
 * Both environments live in project ai-planner-project-467800:
 *   production: Firestore "(default)", functions us-central1 (codebase "default"), site ai-planner-project-467800
 *   staging:    Firestore "staging",   functions asia-south1 (codebase "staging"), site ai-planner-staging
 *
 * Deriving staging from firebase.json keeps headers/CSP, rewrites and ignore lists identical
 * between the two, so what is verified on staging is what ships to production.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

const ENVIRONMENTS = {
    production: { site: 'ai-planner-project-467800', region: 'us-central1', database: '(default)', codebase: 'default' },
    staging: { site: 'ai-planner-staging', region: 'asia-south1', database: 'staging', codebase: 'staging' },
};

function rewriteRegion(rewrite, region) {
    if (!rewrite.function) return rewrite;
    const functionId = typeof rewrite.function === 'string' ? rewrite.function : rewrite.function.functionId;
    return { ...rewrite, function: { functionId, region } };
}

function buildConfig(base, envName) {
    const env = ENVIRONMENTS[envName];
    if (!env) throw new Error(`Unknown environment "${envName}" (expected ${Object.keys(ENVIRONMENTS).join(' or ')})`);
    const config = JSON.parse(JSON.stringify(base));

    if (!Array.isArray(config.functions) || config.functions.length !== 1) {
        throw new Error('firebase.json must define exactly one functions codebase');
    }
    config.functions[0].codebase = env.codebase;

    config.hosting.site = env.site;
    config.hosting.rewrites = (config.hosting.rewrites || []).map(r => rewriteRegion(r, env.region));

    const firestore = Array.isArray(config.firestore) ? config.firestore : [config.firestore];
    if (firestore.length !== 1) throw new Error('firebase.json must define exactly one Firestore database');
    config.firestore = [{ ...firestore[0], database: env.database }];

    delete config.emulators;
    return config;
}

function verify(config, envName) {
    const env = ENVIRONMENTS[envName];
    const problems = [];
    if (config.hosting.site !== env.site) problems.push(`hosting.site is ${config.hosting.site}`);
    if (config.functions[0].codebase !== env.codebase) problems.push(`codebase is ${config.functions[0].codebase}`);
    for (const r of config.hosting.rewrites || []) {
        if (r.function && (typeof r.function === 'string' || r.function.region !== env.region)) {
            problems.push(`rewrite ${r.source} is not pinned to ${env.region}`);
        }
    }
    const dbs = (Array.isArray(config.firestore) ? config.firestore : [config.firestore]).map(f => f.database || '(default)');
    if (dbs.length !== 1 || dbs[0] !== env.database) problems.push(`firestore databases: ${dbs.join(', ')}`);
    return problems;
}

module.exports = { ENVIRONMENTS, buildConfig, verify };

if (require.main === module) {
    const envName = process.argv[2];
    const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));

    const prodProblems = verify(base, 'production');
    if (prodProblems.length) {
        console.error(`❌ firebase.json is not a valid production config:\n  - ${prodProblems.join('\n  - ')}`);
        process.exit(1);
    }
    if (envName === 'production' || envName === '--check') {
        console.log('✅ firebase.json is a valid production config.');
        process.exit(0);
    }

    const config = buildConfig(base, envName);
    const problems = verify(config, envName);
    if (problems.length) {
        console.error(`❌ Generated ${envName} config is invalid:\n  - ${problems.join('\n  - ')}`);
        process.exit(1);
    }
    const out = path.join(ROOT, `firebase.${envName}.json`);
    fs.writeFileSync(out, JSON.stringify(config, null, 2) + '\n');
    console.log(`✅ Wrote ${path.relative(ROOT, out)} (site ${config.hosting.site}, region ${ENVIRONMENTS[envName].region}, database ${ENVIRONMENTS[envName].database}).`);
}
