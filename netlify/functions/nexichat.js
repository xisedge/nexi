const { createClient } = require('@supabase/supabase-js');
const { GoogleGenAI } = require('@google/genai');

// --- CONFIGURATION ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenModel({ model: "gemini-2.5-flash" }); 

// --- CORS HEADERS (The Security Pass) ---
// This allows xisedge.tech to talk to xisedge-api.netlify.app
const headers = {
  'Access-Control-Allow-Origin': '*', 
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  // 1. Handle "Preflight" Check
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // 2. Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method Not Allowed' };
  }

  try {
    const { message, sessionId } = JSON.parse(event.body);

    if (!message || !sessionId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing message or sessionId' }) };
    }

    // 3. RETRIEVE CHAT HISTORY
    const { data: history, error: fetchError } = await supabase
      .from('chat_history')
      .select('role, content')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .limit(10);

    if (fetchError) console.error('Supabase Fetch Error:', fetchError);

    let conversationHistory = history ? history.map(msg => 
      `${msg.role === 'user' ? 'User' : 'NEXI'}: ${msg.content}`
    ).join('\n') : '';

    const systemPrompt = `
      You are NEXI, the AI assistant for XIS EDGE. 
      You are helpful, professional, and concise.
      Your tone is modern and tech-savvy.
      
      HISTORY:
      ${conversationHistory}
      
      USER MESSAGE:
      ${message}
      
      Respond as NEXI:
    `;

    // 4. CALL GEMINI
    const result = await model.generateContent(systemPrompt);
    const responseText = result.response.text();

    // 5. SAVE DATA
    await supabase.from('chat_history').insert([
        { session_id: sessionId, role: 'user', content: message },
        { session_id: sessionId, role: 'assistant', content: responseText }
    ]);

    // 6. RETURN RESPONSE
    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ reply: responseText })
    };

  } catch (error) {
    console.error('Function Error:', error);
    return {
      statusCode: 500,
      headers, 
      body: JSON.stringify({ error: 'Internal Server Error' })
    };
  }
};
