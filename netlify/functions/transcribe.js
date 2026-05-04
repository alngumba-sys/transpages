exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const apiKey = process.env.ASSEMBLYAI_API_KEY;

    if (!apiKey) {
      console.error('ASSEMBLYAI_API_KEY not found');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'AssemblyAI API key not configured. Add ASSEMBLYAI_API_KEY to Netlify environment variables.' }) };
    }

    const { action, audio_data, transcript_id } = body;

    if (action === 'upload') {
      console.log('Upload action - audio data length:', audio_data ? audio_data.length : 0);
      
      const audioBuffer = Buffer.from(audio_data, 'base64');
      console.log('Audio buffer size:', audioBuffer.length, 'bytes');

      // Upload audio to AssemblyAI
      const uploadResp = await fetch('https://api.assemblyai.com/v2/upload', {
        method: 'POST',
        headers: {
          'Authorization': apiKey,
          'Content-Type': 'application/octet-stream'
        },
        body: audioBuffer
      });

      const uploadText = await uploadResp.text();
      console.log('Upload response status:', uploadResp.status);
      console.log('Upload response:', uploadText.substring(0, 200));

      let uploadData;
      try { uploadData = JSON.parse(uploadText); } catch(e) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Upload parse error: ' + uploadText.substring(0, 100) }) };
      }

      if (!uploadData.upload_url) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Upload failed: ' + (uploadData.error || JSON.stringify(uploadData)) }) };
      }

      console.log('Upload URL obtained, requesting transcription...');

      // Request transcription
      const transcriptResp = await fetch('https://api.assemblyai.com/v2/transcript', {
        method: 'POST',
        headers: {
          'Authorization': apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          audio_url: uploadData.upload_url,
          speaker_labels: true,
          speech_models: ["universal-2"]
        })
      });

      const transcriptText = await transcriptResp.text();
      console.log('Transcript response status:', transcriptResp.status);
      console.log('Transcript response:', transcriptText.substring(0, 200));

      let transcriptData;
      try { transcriptData = JSON.parse(transcriptText); } catch(e) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Transcript parse error: ' + transcriptText.substring(0, 100) }) };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ transcript_id: transcriptData.id, status: transcriptData.status })
      };
    }

    if (action === 'poll') {
      const pollResp = await fetch('https://api.assemblyai.com/v2/transcript/' + transcript_id, {
        headers: { 'Authorization': apiKey }
      });

      const pollData = await pollResp.json();

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          status: pollData.status,
          text: pollData.text || '',
          utterances: pollData.utterances || [],
          error: pollData.error || null
        })
      };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid action' }) };

  } catch (error) {
    console.error('Transcription error:', error.message, error.stack);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Transcription failed', message: error.message })
    };
  }
};
