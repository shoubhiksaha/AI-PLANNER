// Warm up every Functions emulator endpoint once so the first test doesn't pay
// cold-start time (module load + SDK init) inside its assertions.
const ENDPOINTS = ['updateProfile', 'refreshStaleStreak', 'setupNotion', 'setupBYOK', 'byokSession',
    'exportUserData', 'deleteUserAccount', 'syncPlanner', 'logClientError'];

module.exports = async () => {
    const base = 'http://127.0.0.1:5001/demo-ai-planner/us-central1';
    await Promise.all(ENDPOINTS.map(async (name) => {
        for (let attempt = 0; attempt < 30; attempt++) {
            try {
                const res = await fetch(`${base}/${name}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5050' },
                    body: '{}',
                });
                if (res.status < 500) return;
            } catch (_) { /* emulator still starting */ }
            await new Promise(r => setTimeout(r, 1000));
        }
        throw new Error(`Functions emulator endpoint ${name} never became ready`);
    }));
};
