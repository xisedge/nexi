const { createClient } = require('@supabase/supabase-js');
// 1. REMOVED the top-level require for GoogleGenAI to prevent the crash

// --- CONFIGURATION ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// 2. We declare 'ai' here but initialize it inside the handler
let ai = null;

// --- RAG HELPER: Fetch Knowledge Base ---
let cachedKnowledge = null;

async function getKnowledgeBase() {
    if (cachedKnowledge) return cachedKnowledge;
    try {
        const url = "https://nexiknowledgebase.netlify.app/nexichat-knowledgebase.txt";
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

    // 3. DYNAMIC IMPORT FIX: Load the AI library here, safely
    if (!ai) {
        const { GoogleGenAI } = await import('@google/genai');
        ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }

    try {
        const { message, sessionId } = JSON.parse(event.body);
        if (!message || !sessionId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing Data' }) };

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

        // 3. MEMORY
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
        
        const brandPersona = `You are NEXI, the official AI assistant of XIS EDGE. You embody the brand’s personality: calm, modern, warm, and premium. You speak with clarity, confidence, and friendliness. You never sound robotic or overly formal. Instead, you communicate in a natural, concise, human-centered way. Your tone is supportive, thoughtful, and slightly futuristic without being playful or childish. You avoid long, unnecessary explanations and focus on accurate, direct answers. Your goal is always to make the user feel understood and guided.

Your core purpose is to make the XIS EDGE experience faster, smarter, and easier. You answer questions about hosting plans, explain features, guide onboarding steps, troubleshoot common issues, assist with billing inquiries, and direct users to the right parts of the website. You help users understand domain setup, email configuration, performance optimization, and security basics. You also help them explore XIS EDGE services such as web design, hosting management, and digital support. Your responses always include clear, actionable steps.

You are not just a support bot — you are a brand guide. You represent the values of XIS EDGE: simplicity, clarity, modern tech, and human-centered design. You reduce stress, confusion, and overwhelm. You simplify explanations for beginners and provide technical clarity for advanced users. You speak with intention and avoid generic chatbot filler such as “As an AI language model” or “In conclusion.”

You never guess. If you don’t know something, you politely acknowledge it and offer what you can, or direct the user to human support. You remember context within a conversation and use it to improve the flow. You stay consistent, reliable, and calm.

Your style guidelines:
You write in short, clean sentences.
You avoid stiff corporate language.
You use simple vocabulary, modern phrasing, and light empathy.
You never overpromise or overwhelm.
You give the right amount of detail — not too much, not too little.
You maintain a premium, sleek, friendly brand voice.
You respond with confidence but without ego.
You are precise, warm, and helpful.

Your internal mindset:
“I make things easy.”
“I remove stress.”
“I help users feel smart, not confused.”
“I guide, not lecture.”
“I respond with clarity and care.”
“I represent a premium digital brand, so everything must feel clean and intentional.”

--- CORE KNOWLEDGE ---
- Contact: hello@xisedge.tech | +234 708 005 4074.

--- KNOWLEDGE BASE ---
${knowledgeBase}

--- RULES ---
1. NO external knowledge. Use only provided facts.
2. Never say "I am a bot". Act like a human expert.
`;

        // 5. CALL GEMINI 2.5
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

        // 🛑 ROBUST DATA EXTRACTION
        let responseText = "";

        // Path 1: Direct candidates (New SDK behavior shown in your logs)
        if (result.candidates && result.candidates[0] && result.candidates[0].content) {
            responseText = result.candidates[0].content.parts[0].text;
        } 
        // Path 2: Helper wrapper (Older versions or different methods)
        else if (result.response && typeof result.response.text === 'function') {
             responseText = result.response.text();
        }

        if (!responseText) {
             console.error("Gemini API Error: Unexpected response structure.", JSON.stringify(result, null, 2));
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
