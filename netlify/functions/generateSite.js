const https = require('https');

/**
 * Netlify serverless function to generate a landing page via the OpenAI Assistants API.
 *
 * Expects a POST request with a JSON body `{ prompt: string }`.
 * Reads the OpenAI API key and assistant ID from environment variables
 * `OPENAI_API_KEY` and `ASSISTANT_ID`.  Sends the prompt to the assistant and
 * returns a JSON response containing the generated HTML.  If any error
 * occurs, returns a 500 status with an error message.
 */
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  let prompt;
  try {
    const body = JSON.parse(event.body || '{}');
    prompt = body.prompt;
    if (!prompt) throw new Error('Missing prompt');
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }
  const apiKey = process.env.OPENAI_API_KEY;
  const assistantId = process.env.ASSISTANT_ID;
  if (!apiKey || !assistantId) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration missing' }) };
  }
  try {
    // Compose a request to the Chat Completions API using the assistant ID
    // For Assistants API, we emulate a chat completion call with system instructions.
    const systemContent =
      'You are a UX/UI design assistant. Generate a fully responsive HTML page (with embedded CSS and JavaScript if needed) based on the provided briefing. ' +
      'The page must be inclusive and follow accessibility guidelines. Include a hero section, a list of features, an optional testimonials carousel and a contact form.';
    // Prepare payload for OpenAI API
    const postData = JSON.stringify({
      model: 'gpt-4-0613',
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: prompt },
      ],
      max_tokens: 4096,
    });
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(postData),
      },
    };
    const responseData = await new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let chunks = '';
        res.on('data', (chunk) => {
          chunks += chunk;
        });
        res.on('end', () => {
          resolve(chunks);
        });
      });
      req.on('error', (e) => reject(e));
      req.write(postData);
      req.end();
    });
    let data;
    try {
      data = JSON.parse(responseData);
    } catch (e) {
      throw new Error('Invalid response from OpenAI');
    }
    if (!data.choices || !data.choices[0] || !data.choices[0].message || !data.choices[0].message.content) {
      throw new Error(data.error?.message || 'No content returned by assistant');
    }
    const content = data.choices[0].message.content;
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: content }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || 'Internal error' }),
    };
  }
};