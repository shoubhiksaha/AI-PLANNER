import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup } from "firebase/auth";
import { getFunctions, connectFunctionsEmulator } from "firebase/functions";

// Replace this with the config object you copied from the Firebase console
const firebaseConfig = {
  apiKey: "AIzaSyBRVEfF58gL3yxQ2UY-_lMgftPnFrZ0_T0",
  authDomain: "ai-planner-project-467800.firebaseapp.com",
  projectId: "ai-planner-project-467800",
  storageBucket: "ai-planner-project-467800.firebasestorage.app",
  messagingSenderId: "195957114195",
  appId: "1:195957114195:web:06bf15f172f55d2ff3cda6",
  measurementId: "G-5PV2GDK402"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const functions = getFunctions(app);
if (window.location.hostname === "localhost") {
    connectAuthEmulator(auth, "http://localhost:9099");
    connectFunctionsEmulator(functions, "localhost", 5001);
}
/**
 * Triggers a Google Login popup and requests permissions.
 * @returns {Promise<string>} The user's Google Access Token.
 */
export const loginAndGetToken = async () => {
    const provider = new GoogleAuthProvider();
    
    // 🚨 REQUESTING PERMISSIONS
    provider.addScope('https://www.googleapis.com/auth/calendar.events');
    provider.addScope('https://www.googleapis.com/auth/tasks');

    try {
        const result = await signInWithPopup(auth, provider);
        const credential = GoogleAuthProvider.credentialFromResult(result);
        return credential.accessToken; // This is the token for the backend
    } catch (error) {
        console.error("Login failed:", error.message);
        throw error;
    }
};