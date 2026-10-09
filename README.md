# Carrot AI — Full Stack

Carrot AI is a Flask-backed AI workspace with a responsive frontend, server-side AI provider requests, document analysis, study tools, and image-generation routing. GitHub stores the source; the Python backend must run on a Python web host (for example Render). GitHub Pages alone cannot execute `app.py`.

## Deploy

1. Upload the contents of this folder to the root of your GitHub repository.
2. Create a Python Web Service from that repository on your backend host. You may use the included `render.yaml` Blueprint.
3. Build command: `pip install -r requirements.txt`
4. Start command: `gunicorn app:app --bind 0.0.0.0:$PORT --workers 2 --timeout 180`
5. Add private environment variables in the hosting dashboard:
   - `AI_API_KEY`: Hugging Face token with Inference Providers permission.
   - `AI_API_URL`: `https://router.huggingface.co/v1/chat/completions`
   - `AI_MODEL`: `openai/gpt-oss-120b:fastest` (change to a model available to your account)
   - `IMAGE_API_URL`: `https://router.huggingface.co/hf-inference/models/{model}`
   - `IMAGE_API_KEY`: optional separate image token; if omitted, `AI_API_KEY` is used.
   - `IMAGE_MODEL`: `black-forest-labs/FLUX.1-dev` (change to a model your account can access)
6. Deploy, then open `/api/health` on the deployed site. `ai_configured` should be `true` when the server has the key.

## Settings

Click the `?` button in the app header to open the Settings control center. It includes connection health, chat/image model preferences, response style, theme, history preferences, and privacy notes. Provider credentials are intentionally configured as server environment variables and never sent to the browser. Model preferences are saved locally and passed to the server as request headers.

## Current capabilities

- Chat with conversation context.
- Summaries, flashcards, and quizzes generated from text or uploaded documents.
- Document analysis for text files, PDFs with selectable text, DOCX, XLSX/XLSM, and ZIP archives containing supported text/code files.
- Image generation through a configurable provider endpoint.
- Browser OCR for images and scanned PDFs using Tesseract.js where the client-side upload/OCR flow is used.
- Local conversation history and export.

## Notes and limitations

- Image generation and AI responses require valid provider credentials, accessible models, and sufficient provider quota.
- The backend extracts selectable PDF text. Scanned PDFs should be processed by the browser OCR workflow; a server-side OCR binary is not included.
- Search opens external search results rather than scraping search pages.
- Free web hosting may sleep or have resource limits.
- Do not commit `.env` files or provider keys. The API key is never exposed by `/api/health`.
