const { createClient } = require('@supabase/supabase-js');
// --- CONFIGURATION ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// We initialize Gemini inside the handler via dynamic import to avoid ESM errors
let ai = null;

// --- RAG HELPER: Fetch Knowledge Base ---
let cachedKnowledge = null;

async function getKnowledgeBase() {
    if (cachedKnowledge) return cachedKnowledge;
    try {
        const url = "https://bluaiknowledgev2.netlify.app/blu-ai-knowledge.txt";
        const response = await fetch(url);
        if (response.status !== 200) return "";
        const text = await response.text();
        cachedKnowledge = text.substring(0, 20000); 
        return cachedKnowledge;
    } catch (e) {
        console.error("RAG Fetch Error:", e);
        return "";
    }
}

// --- CORS HEADERS ---
const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
    // 1. Handle Preflight & Methods
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

    // 3. DYNAMIC IMPORT FIX
    if (!ai) {
        const { GoogleGenAI } = await import('@google/genai');
        ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }

    try {
        const body = JSON.parse(event.body);
        const { message, sessionId, loadHistory } = body;

        if (!sessionId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing Session ID' }) };

        // --- A. HISTORY LOADING MODE ---
        if (loadHistory) {
            const { data: fullHistory, error } = await supabase
                .from('chat_history')
                .select('role, content, created_at')
                .eq('session_id', sessionId)
                .order('created_at', { ascending: true }); // Oldest first for display

            if (error) throw error;

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ history: fullHistory || [] })
            };
        }

        // --- B. CHAT MESSAGE MODE ---
        if (!message) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing Message' }) };

        // 2. TRIVIAL RESPONSES
        const lower = message.toLowerCase().trim();
        const trivialResponses = {
            'thanks': "You're very welcome! Let me know if you need anything else.",
            'thank you': "You're very welcome! Let me know if you need anything else.",
            'bye': "Goodbye! Have a great day.",
            'goodbye': "Goodbye! Have a great day."
        };

        if (trivialResponses[lower]) {
            const reply = trivialResponses[lower];
            await supabase.from('chat_history').insert([
                { session_id: sessionId, role: 'user', content: message },
                { session_id: sessionId, role: 'assistant', content: reply }
            ]);
            return { statusCode: 200, headers, body: JSON.stringify({ reply: reply }) };
        }

        // 3. MEMORY (Fetch Context for AI)
        const { data: history } = await supabase
            .from('chat_history')
            .select('role, content')
            .eq('session_id', sessionId)
            .order('created_at', { ascending: true })
            .limit(12);

        const pastMessages = history ? history.map(msg => ({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }]
        })) : [];

        // 4. PREPARE CONTEXT
        const knowledgeBase = await getKnowledgeBase();
        
        const brandPersona = `You are "Blu," the expert assistant for I AM XIS. 
Your tone is professional, concise, and friendly.

--- CORE KNOWLEDGE ---
- Production: 3-5 business days.
- Shipping: Depends on carrier.
- Returns: 7 days, ONLY if damaged.
- Contact: hello@iamxis.studio | +234 708 005 4074.

--- KNOWLEDGE BASE ---
${knowledgeBase}

--- RULES ---
1. NO external knowledge. Use only provided facts.
2. If asked about "iamxis.com.ng", explain we are temporarily on "iamxis.studio".
3. Use "---BREAK---" to separate distinct concepts.
4. If a user says "I want to order", reply: "You can order directly via our shop here - https://iamxis.studio/shop".
5. Never say "I am a bot". Act like a human expert.
`;

        // 5. CALL GEMINI
        const contents = [
            {
                role: "user",
                parts: [{ text: brandPersona }] 
            },
            {
                role: "model",
                parts: [{ text: "Understood. I am Blu. I will follow all rules." }]
            },
            ...pastMessages,
            {
                role: "user",
                parts: [{ text: message }]
            }
        ];

        const result = await ai.models.generateContent({
            model: "gemini-2.5-flash", 
            contents: contents
        });

        let responseText = "";
        if (result.candidates && result.candidates[0] && result.candidates[0].content) {
            responseText = result.candidates[0].content.parts[0].text;
        } else if (result.response && typeof result.response.text === 'function') {
             responseText = result.response.text();
        }

        if (!responseText) {
             throw new Error("The AI model returned an empty or blocked response.");
        }
        
        responseText = responseText.replace(/---BREAK---/g, '\n\n');

        // 6. SAVE & RETURN
        await supabase.from('chat_history').insert([
            { session_id: sessionId, role: 'user', content: message },
            { session_id: sessionId, role: 'assistant', content: responseText }
        ]);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ reply: responseText })
        };

    } catch (error) {
        console.error('Handler Error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};
