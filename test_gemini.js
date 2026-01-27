const GEMINI_API_KEY = "AIzaSyA663aK1gviWhHBNWGwkaiSTjX872N3WHU";

async function testGemini() {
    // Correct URL for v1beta and gemini-2.5-flash
    const geminiApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

    // Minimal valid payload
    const geminiPayload = {
        contents: [
            {
                parts: [
                    { text: "Return a JSON object with a key 'message' and value 'Hello World'." }
                ]
            }
        ],
        generationConfig: {
            responseMimeType: "application/json"
        }
    };

    console.log("Testing URL:", geminiApiUrl);

    try {
        const response = await fetch(geminiApiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(geminiPayload)
        });

        if (!response.ok) {
            const text = await response.text();
            console.error(`Error ${response.status}:`, text);
        } else {
            const data = await response.json();
            console.log("Success:", JSON.stringify(data, null, 2));
        }
    } catch (e) {
        console.error("Exception:", e);
    }
}

testGemini();
