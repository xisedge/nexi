// --- CONFIGURATION ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// --- RAG HELPER: Fetch Knowledge Base ---
// We use a global variable to cache this so we don't fetch it 100 times a second.
let cachedKnowledge = null;

async function getKnowledgeBase() {
    if (cachedKnowledge) return cachedKnowledge;
    try {
        const url = "https://bluaiknowledgev2.netlify.app/blu-ai-knowledge.txt";
        const response = await fetch(url);
        if (response.status !== 200) return "";
        const text = await response.text();
        // Limit context to 20k chars to save tokens, adjust as needed
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

    try {
        const { message, sessionId } = JSON.parse(event.body);
        if (!message || !sessionId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing Data' }) };

        // 2. CHECK FOR TRIVIAL PROMPTS (Optimization)
        // We handle these locally to save money/time, BUT we must save them to DB so memory stays consistent.
        const lower = message.toLowerCase().trim();
        const trivialResponses = {
            'thanks': "You're very welcome! Let me know if you need anything else.",
            'thank you': "You're very welcome! Let me know if you need anything else.",
            'bye': "Goodbye! Have a great day.",
            'goodbye': "Goodbye! Have a great day."
        };

        if (trivialResponses[lower]) {
            const reply = trivialResponses[lower];
            // Save to Supabase so context isn't lost
            await supabase.from('chat_history').insert([
                { session_id: sessionId, role: 'user', content: message },
                { session_id: sessionId, role: 'assistant', content: reply }
            ]);
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ reply: reply })
            };
        }

        // 3. RETRIEVE MEMORY (Supabase)
        // Fetch last 10 messages for context
        const { data: history } = await supabase
            .from('chat_history')
            .select('role, content')
            .eq('session_id', sessionId)
            .order('created_at', { ascending: true })
            .limit(10);

        // Convert DB history to Gemini SDK Format
        const pastMessages = history ? history.map(msg => ({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }]
        })) : [];

        // 4. PREPARE RAG CONTEXT & PERSONA
        const knowledgeBase = await getKnowledgeBase();
        
        // This is your exact Persona + Rules block
        const brandPersona = `You are "Blu," the dedicated, expert customer service assistant for I AM XIS. Your authority is derived only from the provided knowledge and rules.

--- BRAND IDENTITY ---
Core Business: I AM XIS is a premium design studio creating personalized, made-to-order essentials.
Tone: Professional, concise, explicitly friendly but not overly informal.
Constraint: Never mention you are an AI.

--- KNOWLEDGE BASE ---
${knowledgeBase}

--- STRICT RULES (SUMMARY) ---
1. NO external knowledge. Use only provided facts.
2. If asked about "iamxis.com.ng", explain we are temporarily on "iamxis.studio".
3. Use "---BREAK---" to separate distinct concepts.
4. If a user says "I want to order", reply: "You can order directly via our shop here - https://iamxis.studio/shop".
5. Delivery: 3-5 business days.
6. Returns: 7 days, ONLY if damaged.
7. Support Email: hello@iamxis.studio
8. Check "blu-ai-knowledge.txt" for all other 59 specific rules.
`;

        // 5. CALL GEMINI (New SDK)
        // We prime the model with the System Instruction first
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

        let responseText = result.response.text();
        
        // Clean up the "---BREAK---" for the HTML Frontend
        responseText = responseText.replace(/---BREAK---/g, '\n\n');

        // 6. SAVE TO DB
        await supabase.from('chat_history').insert([
            { session_id: sessionId, role: 'user', content: message },
            { session_id: sessionId, role: 'assistant', content: responseText }
        ]);

        // 7. RETURN (mapped to 'reply' for your frontend)
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
