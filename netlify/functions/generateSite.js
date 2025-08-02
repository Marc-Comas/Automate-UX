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
    // System prompt: instruct the model to create a comprehensive, modern landing page
    // with multiple sections and interactive elements.  The assistant should
    // incorporate relevant images (using unsplash placeholders), follow
    // accessibility guidelines, and include subtle animations.  Adjust
    // the prompt to produce professional, engaging layouts.
    const systemContent = `
You are a professional web and UX/UI designer tasked with creating complete landing pages.

Your goal is to generate a full, production‑ready HTML document (with embedded CSS and, if necessary, a small amount of JavaScript) that is fully responsive and accessible.

Given a client briefing, you must:
  1. Interpret the brand goals and aesthetic from the briefing.
  2. Choose an appropriate colour palette with high contrast and a modern feel.
  3. Design the following sections:
     • **Hero section**: includes a powerful headline, a short subheading, a call‑to‑action button, and a relevant background image (use unsplash placeholders like https://source.unsplash.com/featured/?{keyword}).
     • **Highlights or features section**: convert key points from the briefing into 3–4 cards or bullets, each with an icon (you may use emojis) and a concise description.
     • **Gallery section**: display two or more image thumbnails related to the client’s industry using unsplash placeholder URLs.  Images should be responsive and include alt text.
     • **Testimonials section**: create at least three testimonial slides with quotes, names, and optional star ratings.  Implement a simple carousel using CSS/JS for automatic sliding.
     • **Contact section**: include a form with fields for name, email, and message, plus a submit button.  Provide form validation and a thank‑you message on submit.
  4. Add smooth scrolling navigation links to each section in a sticky header.
  5. Apply CSS styles to achieve a clean, modern layout (e.g., lots of white space, rounded cards, subtle shadows).  Use CSS transitions or keyframe animations to fade or slide elements in.
  6. Ensure the generated HTML adheres to accessibility best practices: semantic tags, alt attributes on images, proper contrast, keyboard navigability.

Return **only** the final HTML document as a string, without additional commentary.
`;
    // Prepare payload for OpenAI API
    const postData = JSON.stringify({
      model: 'gpt-4-0613',
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: prompt },
      ],
      max_tokens: 4096,
      temperature: 0.7,
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