// AI Planner — Environment Configuration Module
// Loaded before app-helpers.js and app.js
// In CI/CD pipelines, this file is populated dynamically with environment variables.
// Default local configuration points to staging for developer safety.

window.__ENV_CONFIG__ = {
    apiKey: "AIzaSyBRVEfF58gL3yxQ2UY-_lMgftPnFrZ0_T0",
    authDomain: "ai-planner-project-467800.firebaseapp.com",
    projectId: "ai-planner-project-467800",
    storageBucket: "ai-planner-project-467800.firebasestorage.app",
    messagingSenderId: "195957114195",
    appId: "1:195957114195:web:06bf15f172f55d2ff3cda6",
    environment: "staging",
    hostingUrl: "https://ai-planner-staging.web.app",
    // One project, two environments: staging uses its own Firestore database
    // and functions region (production: "(default)" / "us-central1").
    firestoreDatabaseId: "staging",
    functionsRegion: "asia-south1",
    // C9: reCAPTCHA Enterprise site key; empty = App Check off on the client.
    appCheckSiteKey: ""
};
