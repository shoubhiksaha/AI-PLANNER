const {
    initializeTestEnvironment,
    assertFails,
    assertSucceeds,
} = require('@firebase/rules-unit-testing');
const fs = require('fs');

describe('Firestore Security Rules', () => {
    let testEnv;

    beforeAll(async () => {
        // Read the firestore.rules file from the parent directory
        const rules = fs.readFileSync('../firestore.rules', 'utf8');

        // Initialize the test environment, pointing to the local emulator
        testEnv = await initializeTestEnvironment({
            projectId: 'ai-planner-project-467800',
            firestore: {
                rules: rules,
                host: 'localhost',
                port: 8080 // Ensure the Firestore emulator is running on this port
            },
        });
    });

    afterAll(async () => {
        // Cleanup the environment
        await testEnv.cleanup();
    });

    beforeEach(async () => {
        // Clear data before each test
        await testEnv.clearFirestore();
    });

    // Helper function to create an authenticated context
    const getAuthDb = (email) => {
        return testEnv.authenticatedContext('user-id', { email }).firestore();
    };

    // Helper function for unauthenticated context
    const getUnauthDb = () => {
        return testEnv.unauthenticatedContext().firestore();
    };

    test('Authenticated user can read their own document', async () => {
        const db = getAuthDb('testuser@example.com');
        const docRef = db.collection('users').doc('testuser@example.com');
        await assertSucceeds(docRef.get());
    });

    test('Authenticated user CANNOT read another user\'s document', async () => {
        const db = getAuthDb('hacker@example.com');
        const docRef = db.collection('users').doc('testuser@example.com');
        await assertFails(docRef.get());
    });

    test('Unauthenticated user CANNOT read any document', async () => {
        const db = getUnauthDb();
        const docRef = db.collection('users').doc('testuser@example.com');
        await assertFails(docRef.get());
    });

    test('Authenticated user CANNOT write to their own document (Writes are Admin-only)', async () => {
        const db = getAuthDb('testuser@example.com');
        const docRef = db.collection('users').doc('testuser@example.com');
        await assertFails(docRef.set({ name: 'Hacked' }));
    });
});
