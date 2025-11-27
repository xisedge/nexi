const { createClient } = require('@supabase/supabase-js');

// --- CONFIGURATION ---
// Initialize Supabase immediately
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Initialize Gemini variable (loaded dynamically later to fix Netlify ESM errors)
let ai = null;

// --- RAG HELPER: Fetch Knowledge Base ---
// We use a global variable to cache this so we don't fetch it on every single request.
let cachedKnowledge = null;

async function getKnowledgeBase() {
    if (cachedKnowledge) return cachedKnowledge;
    try {
        const url = "https://bluaiknowledgev2.netlify.app/blu-ai-knowledge.txt";
        const response = await fetch(url);
        if (response.status !== 200) return "";
        const text = await response.text();
        cachedKnowledge = text.substring(0, 20000); // Limit context size to save tokens
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

    // 2. DYNAMIC IMPORT (Fixes ESM Error)
    if (!ai) {
        const { GoogleGenAI } = await import('@google/genai');
        ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }

    try {
        const body = JSON.parse(event.body);
        const { message, sessionId, action, userDetails, userName } = body;

        if (!sessionId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing Session ID' }) };

        // ============================================================
        // ACTION A: SAVE LEAD (Progressive Profiling)
        // ============================================================
        if (action === 'saveLead') {
            const { error } = await supabase.from('leads').insert([{
                session_id: sessionId,
                name: userDetails.name,
                email: userDetails.email,
                phone: userDetails.phone
            }]);
            
            if (error) console.error('Lead Save Error:', error);
            
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ success: true })
            };
        }

        // ============================================================
        // ACTION B: LOAD HISTORY (Persistent Chat)
        // ============================================================
        if (action === 'loadHistory') {
            const { data: fullHistory } = await supabase
                .from('chat_history')
                .select('role, content')
                .eq('session_id', sessionId)
                .order('created_at', { ascending: true });

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ history: fullHistory || [] })
            };
        }

        // ============================================================
        // ACTION C: NORMAL CHAT MESSAGE
        // ============================================================
        if (!message) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing Message' }) };

        // 2.1. TRIVIAL RESPONSES (Optimization)
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

        // 2.2. FETCH CONTEXT (Memory)
        const { data: history } = await supabase
            .from('chat_history')
            .select('role, content')
            .eq('session_id', sessionId)
            .order('created_at', { ascending: true })
            .limit(10);

        const pastMessages = history ? history.map(msg => ({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }]
        })) : [];

        // 2.3. PREPARE PERSONA & RAG
        const knowledgeBase = await getKnowledgeBase();
        
        // PERSONALIZATION: Inject the user's name if we have it
        const userContext = userName ? `The user's name is ${userName}. Address them by name naturally occasionally.` : '';

        const brandPersona = `You are "Blu," the dedicated, expert customer service assistant for I AM XIS. 
Your tone is professional, concise, and explicitly friendly.
${userContext}

--- KNOWLEDGE BASE ---
${knowledgeBase}

--- STRICT RULES ---
1. NO external knowledge. Use only provided facts.
2. If asked about "iamxis.com.ng", explain we are temporarily on "iamxis.studio".
3. Use "---BREAK---" to separate distinct concepts (this becomes a new paragraph).
4. If a user says "I want to order", reply exactly: "You can order directly via our shop here - https://iamxis.studio/shop".
5. Delivery: 3-5 business days (Made-to-order).
6. Returns: 7 days, ONLY if damaged.
7. Support: hello@iamxis.studio
8. Never mention you are an AI or a bot. Act like a human expert.
`;

        // 2.4. CALL GEMINI
        const contents = [
            { role: "user", parts: [{ text: brandPersona }] },
            { role: "model", parts: [{ text: "Understood. I am Blu." }] },
            ...pastMessages,
            { role: "user", parts: [{ text: message }] }
        ];

        const result = await ai.models.generateContent({
            model: "gemini-2.5-flash", 
            contents: contents
        });

        // 2.5. EXTRACT RESPONSE SAFELY
        let responseText = "";
        if (result.candidates && result.candidates[0] && result.candidates[0].content) {
            responseText = result.candidates[0].content.parts[0].text;
        } else if (result.response && typeof result.response.text === 'function') {
             responseText = result.response.text();
        }

        if (!responseText) throw new Error("Empty Response from AI");
        
        responseText = responseText.replace(/---BREAK---/g, '\n\n');

        // 2.6. SAVE CONVERSATION
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
