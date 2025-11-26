const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- CONFIGURATION ---
// Connect to Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // Use Service Role Key for backend!
const supabase = createClient(supabaseUrl, supabaseKey);

// Connect to Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); 

exports.handler = async (event) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { message, sessionId } = JSON.parse(event.body);

    if (!message || !sessionId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing message or sessionId' }) };
    }

    // 1. RETRIEVE CHAT HISTORY (Memory)
    // We fetch the last 10 messages for this session to give Gemini context.
    const { data: history, error: fetchError } = await supabase
      .from('chat_history')
      .select('role, content')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true }) // Oldest first for context window
      .limit(10);

    if (fetchError) console.error('Supabase Fetch Error:', fetchError);

    // 2. CONSTRUCT THE PROMPT
    // We format the history into a conversation style for the AI.
    let conversationHistory = history ? history.map(msg => 
      `${msg.role === 'user' ? 'User' : 'NEXI'}: ${msg.content}`
    ).join('\n') : '';

    // The System Prompt (NEXI's Personality)
    const systemPrompt = `
      You are NEXI, the AI assistant for XIS EDGE. 
      You are helpful, professional, and concise.
      Your tone is modern and tech-savvy.
      If you don't know an answer, politely ask for more details or offer to connect them to support.
      
      HISTORY OF CONVERSATION:
      ${conversationHistory}
      
      CURRENT USER MESSAGE:
      ${message}
      
      Respond as NEXI:
    `;

    // 3. CALL GEMINI API
    const result = await model.generateContent(systemPrompt);
    const responseText = result.response.text();

    // 4. SAVE DATA (Store the conversation)
    // We save BOTH the user's question and NEXI's answer to the DB.
    const { error: insertError } = await supabase
      .from('chat_history')
      .insert([
        { session_id: sessionId, role: 'user', content: message },
        { session_id: sessionId, role: 'assistant', content: responseText }
      ]);

    if (insertError) console.error('Supabase Insert Error:', insertError);

    // 5. RETURN RESPONSE TO UI
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply: responseText })
    };

  } catch (error) {
    console.error('Function Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal Server Error' })
    };
  }
};
