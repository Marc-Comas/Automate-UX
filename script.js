/*
 * Main JavaScript for the landing page builder dashboard.
 *
 * This script implements a simple single‑page application that
 * manages a collection of landing page projects.  Projects are stored
 * in the browser's localStorage so that they persist across sessions.
 * Each project contains the original prompt and a generated HTML
 * landing page.  The user can preview and download the resulting
 * landing page directly from the dashboard.  A JSON file under
 * assets/images.json provides base64‑encoded images to use in the
 * generated pages.
 */

(function () {
  // === Configuration for external integrations ===
  // Netlify build hook URL.  Triggering this URL will cause Netlify to rebuild
  // the associated project.  This value is user‑provided and considered
  // sensitive; do not expose it in the UI.  Replace with your own hook if needed.
  const NETLIFY_BUILD_HOOK = 'https://api.netlify.com/build_hooks/6870fc2a249a19a924f033d9';

  // GitHub personal access token used to push generated projects to a repository.
  // Treat this as confidential: never log or display it.  The repository
  // configuration below determines where files will be created.
  const GITHUB_TOKEN = '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';

  // Repository and branch where projects will be uploaded.  The GitHub API
  // requires both the owner/name and the branch.  Adjust these values if you
  // change the target repository.
  const GITHUB_REPO = 'Marc-Comas/Automate-UX';
  const GITHUB_BRANCH = 'main';

  // === Custom GPT integration ===
  // The dashboard previously supported a custom GPT endpoint.  This has
  // been superseded by the Netlify function integration that calls the
  // OpenAI Assistant.  The following constants and helpers have been
  // removed to avoid confusion.

  /**
   * Call the custom GPT service to generate a landing page.  This
   * function posts the project name and prompt to a configurable
   * endpoint and expects to receive back an object with an `html`
   * property containing the full page.  If the call fails or the
   * response is invalid, the promise rejects.
   * @param {string} name The project name.
   * @param {string} prompt The project prompt.
   * @returns {Promise<string>} A promise that resolves with HTML.
   */

  /**
   * Generate a landing page via the Netlify serverless function that
   * proxies the OpenAI Assistant.  The function accepts a JSON
   * payload with the prompt and returns a JSON object with an
   * `html` property.  If the request fails or returns invalid data,
   * the promise rejects.
   * @param {string} name The project name (unused, reserved for future extensions).
   * @param {string} prompt The user briefing describing the site.
   * @returns {Promise<string>} A promise resolving with the generated HTML.
   */
  function generateViaAssistant(name, prompt) {
    return new Promise((resolve, reject) => {
      fetch('/.netlify/functions/generateSite', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prompt }),
      })
        .then((res) => {
          if (!res.ok) throw new Error('Assistant request failed');
          return res.json();
        })
        .then((data) => {
          if (data && data.html && typeof data.html === 'string') {
            resolve(data.html);
          } else {
            throw new Error('Invalid assistant response');
          }
        })
        .catch((err) => reject(err));
    });
  }
  // Views mapping: each key corresponds to a section id
  const views = {
    dashboard: document.getElementById('dashboard-view'),
    new: document.getElementById('new-view'),
    profile: document.getElementById('profile-view'),
    faq: document.getElementById('faq-view'),
    settings: document.getElementById('settings-view'),
    support: document.getElementById('support-view'),
  };

  // Navigation elements
  const navItems = document.querySelectorAll('#sidebar nav li.nav-item');
  const btnNew = document.getElementById('btn-new');
  const btnCancel = document.getElementById('btn-cancel');

  // Load stored projects or initialize empty list
  let projects = [];
  const stored = localStorage.getItem('projects');
  if (stored) {
    try {
      projects = JSON.parse(stored);
    } catch (e) {
      console.warn('Could not parse projects from localStorage', e);
      projects = [];
    }
  }

  // Base64 images loaded from JSON file
  let images = {};
  fetch('assets/images.json')
    .then((res) => res.json())
    .then((data) => {
      images = data;
    })
    .catch((err) => {
      console.error('Failed to load images', err);
    });

  /**
   * Persist the projects array to localStorage.
   */
  function saveProjects() {
    localStorage.setItem('projects', JSON.stringify(projects));
  }

  /**
   * Create a ZIP archive for a project.  The archive contains a single
   * file named "index.html" with the generated HTML.  JSZip must be
   * available globally (see index.html for the script include).
   * @param {Object} project The project to archive.
   * @returns {Promise<Blob>} A promise resolving with the ZIP blob.
   */
  function createZip(project) {
    const zip = new JSZip();
    zip.file('index.html', project.html);
    return zip.generateAsync({ type: 'blob' });
  }

  /**
   * Trigger a download of a ZIP file containing the project HTML.
   * @param {Object} project The project whose archive to download.
   */
  function downloadZip(project) {
    createZip(project).then((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = project.name.replace(/\s+/g, '_').toLowerCase() + '.zip';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }

  /**
   * Copy the generated HTML for a project to the clipboard so that it
   * can be imported into Figma via a plugin.  If the clipboard API
   * fails (e.g. due to browser permissions), open the HTML in a new
   * tab as a fallback so that the user can copy it manually.
   * @param {Object} project The project to export.
   */
  function exportToFigma(project) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(project.html)
        .then(() => {
          alert('El codi HTML s\'ha copiat al porta-retalls. Obre Figma i enganxa-ho al connector HTML to Figma.');
        })
        .catch(() => {
          // Fallback: open HTML in new tab for manual copy
          const blob = new Blob([project.html], { type: 'text/html' });
          const url = URL.createObjectURL(blob);
          window.open(url, '_blank');
        });
    } else {
      const blob = new Blob([project.html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    }
  }

  /**
   * Trigger a rebuild on Netlify via the configured build hook.  This
   * function simply POSTs to the hook URL; Netlify uses the hook
   * configuration to pull the latest contents from GitHub and deploy
   * them.  No project data is sent in the request body.
   * @param {Object} project The project to deploy (unused but kept for API parity).
   */
  function deployProject(project) {
    fetch(NETLIFY_BUILD_HOOK, { method: 'POST' })
      .then((response) => {
        if (response.ok) {
          alert('S\'ha iniciat la construcció a Netlify. Revisa la teva compte per l\'estat del deploy.');
        } else {
          alert('Error en desencadenar el deploy a Netlify.');
        }
      })
      .catch(() => {
        alert('No s\'ha pogut connectar a Netlify.');
      });
  }

  /**
   * Upload a project archive to GitHub.  The ZIP is created on the
   * client using JSZip and then uploaded via the GitHub REST API.
   * Files are created under a `projects/` directory in the target
   * repository.  Existing files with the same name will be overwritten.
   * @param {Object} project The project to upload.
   */
  function uploadToGitHub(project) {
    createZip(project).then((blob) => {
      const reader = new FileReader();
      reader.onload = function () {
        const dataUrl = reader.result;
        const base64 = dataUrl.split(',')[1];
        const fileName = project.name.replace(/\s+/g, '_').toLowerCase() + '.zip';
        const filePath = 'projects/' + fileName;
        const body = {
          message: 'Add project ' + project.name,
          content: base64,
          branch: GITHUB_BRANCH,
        };
        fetch('https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + filePath, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + GITHUB_TOKEN,
          },
          body: JSON.stringify(body),
        })
          .then((res) => {
            if (res.ok) {
              alert('El projecte s\'ha pujat a GitHub correctament.');
            } else {
              return res.json().then((data) => {
                throw new Error(data.message || 'Error en pujar a GitHub');
              });
            }
          })
          .catch((err) => {
            alert('Error en pujar a GitHub: ' + err.message);
          });
      };
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Switch the visible view based on a given key.  All other
   * views are hidden via the `hidden` class.
   * @param {string} key Name of the view to show (dashboard, new, etc.)
   */
  function showView(key) {
    Object.keys(views).forEach((k) => {
      views[k].classList.toggle('hidden', k !== key);
    });
    // update nav highlighting
    navItems.forEach((item) => {
      item.classList.toggle('active', item.dataset.view === key);
    });
  }

  /**
   * Render the list of projects into the dashboard.  Each project card
   * includes the project name, a snippet of the prompt, and action
   * buttons to preview or download the generated page.
   */
  function renderProjects() {
    const listEl = document.getElementById('project-list');
    listEl.innerHTML = '';
    if (projects.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'No projects yet. Click “New Project” to get started.';
      listEl.appendChild(empty);
      return;
    }
    projects.forEach((project) => {
      const card = document.createElement('div');
      card.className = 'project-card';
      // info
      const info = document.createElement('div');
      info.className = 'project-info';
      const title = document.createElement('h3');
      title.textContent = project.name;
      const desc = document.createElement('p');
      desc.textContent = project.prompt.length > 120 ? project.prompt.slice(0, 117) + '…' : project.prompt;
      info.appendChild(title);
      info.appendChild(desc);
      // actions
      const actions = document.createElement('div');
      actions.className = 'project-actions';
      // Preview button
      const btnPreview = document.createElement('button');
      btnPreview.className = 'secondary';
      btnPreview.textContent = 'Preview';
      btnPreview.addEventListener('click', () => openPreview(project));
      // Download ZIP button
      const btnZip = document.createElement('button');
      btnZip.className = 'secondary';
      btnZip.textContent = 'Download ZIP';
      btnZip.addEventListener('click', () => downloadZip(project));
      // Export to Figma button
      const btnFigma = document.createElement('button');
      btnFigma.className = 'secondary';
      btnFigma.textContent = 'Export Figma';
      btnFigma.addEventListener('click', () => exportToFigma(project));
      // Deploy to Netlify button
      const btnDeploy = document.createElement('button');
      btnDeploy.className = 'secondary';
      btnDeploy.textContent = 'Deploy';
      btnDeploy.addEventListener('click', () => deployProject(project));
      // Upload to GitHub button
      const btnPush = document.createElement('button');
      btnPush.className = 'secondary';
      btnPush.textContent = 'Upload GitHub';
      btnPush.addEventListener('click', () => uploadToGitHub(project));
      // Append all action buttons
      actions.appendChild(btnPreview);
      actions.appendChild(btnZip);
      actions.appendChild(btnFigma);
      actions.appendChild(btnDeploy);
      actions.appendChild(btnPush);
      card.appendChild(info);
      card.appendChild(actions);
      listEl.appendChild(card);
    });
  }

  /**
   * Open a preview of the generated landing page in a new browser tab.
   * A Blob URL is created from the HTML string so that images encoded
   * as data URIs will display correctly.
   * @param {Object} project The project to preview.
   */
  function openPreview(project) {
    const blob = new Blob([project.html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    // The URL will be released automatically when the tab is closed.
  }

  /**
   * Trigger a download of the generated landing page.  The file
   * downloaded is a single HTML document with embedded assets.
   * @param {Object} project The project whose file to download.
   */
  function downloadProject(project) {
    const blob = new Blob([project.html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = project.name.replace(/\s+/g, '_').toLowerCase() + '.html';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Generate an HTML string for a new landing page based on a
   * project name and free‑form prompt.  The prompt is naively split
   * into sentences to extract up to three features to display.  The
   * resulting page includes a header with navigation, a hero section,
   * a features list, a gallery and a footer.  Embedded base64 images
   * ensure the preview functions without external assets.
   * @param {string} name The project name.
   * @param {string} prompt A description of the landing page content.
   * @returns {string} Complete HTML document as a string.
   */
  function generateLandingHTML(name, prompt) {
    // Attempt to extract up to 3 descriptive sentences for features
    const sentences = prompt
      .split(/\.|\n|!|\?/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const features = sentences.slice(0, 3);
    // Fallback feature list if none provided
    if (features.length === 0) {
      features.push('Beautifully crafted sections that tell your story');
      features.push('Responsive design that works on every device');
      features.push('Easy contact form to capture leads');
    }
    // Build the features list HTML
    const featuresHTML = features
      .map((f) => `<li><strong>${f.charAt(0).toUpperCase() + f.slice(1)}</strong></li>`) 
      .join('\n          ');
    // Use loaded base64 images.  If images are not loaded yet
    // (e.g., on first run), fallback to empty strings to avoid errors.
    const hero1 = images.hero1 || '';
    const hero2 = images.hero2 || '';
    const hero3 = images.hero3 || '';
    // HTML template for the landing page
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name}</title>
  <style>
    body { margin:0; font-family: Arial, Helvetica, sans-serif; color:#333; }
    header { background:#ffffff; padding:1rem 2rem; display:flex; justify-content:space-between; align-items:center; box-shadow:0 1px 4px rgba(0,0,0,0.1); position:sticky; top:0; }
    header h1 { margin:0; font-size:1.4rem; color:#0066ff; }
    nav ul { list-style:none; margin:0; padding:0; display:flex; gap:1rem; }
    nav a { text-decoration:none; color:#0066ff; font-weight:bold; }
    .hero { background-image:url('${hero1}'); background-size:cover; background-position:center; color:#fff; padding:80px 20px; text-align:center; }
    .hero h2 { margin:0 0 1rem; font-size:2.4rem; }
    .hero p { font-size:1.1rem; max-width:600px; margin:0 auto; }
    .cta-btn { margin-top:2rem; padding:0.8rem 1.5rem; background:#ffffff33; border:2px solid #fff; color:#fff; border-radius:4px; text-decoration:none; display:inline-block; }
    .features { padding:60px 20px; background:#f9f9f9; }
    .features h3 { text-align:center; margin-bottom:2rem; font-size:1.8rem; }
    .features ul { list-style:none; padding:0; max-width:800px; margin:0 auto; display:grid; grid-template-columns:repeat(auto-fit, minmax(200px,1fr)); gap:1rem; }
    .features li { background:#fff; border:1px solid #e0e0e0; padding:1rem; border-radius:6px; box-shadow:0 1px 2px rgba(0,0,0,0.05); }
    .gallery { padding:60px 20px; display:flex; flex-wrap:wrap; justify-content:center; gap:1rem; }
    .gallery img { width:300px; height:200px; object-fit:cover; border-radius:6px; }
    footer { background:#0066ff; color:#fff; text-align:center; padding:1.5rem 20px; }
    footer p { margin:0; font-size:0.9rem; }
    /* Testimonials carousel */
    .testimonials { padding:60px 20px; background:#ffffff; text-align:center; }
    .testimonials h3 { margin-bottom:1.5rem; font-size:1.8rem; color:#333; }
    .testimonial-container { position:relative; max-width:800px; margin:0 auto; }
    .testimonial { display:none; font-style:italic; font-size:1.1rem; color:#555; }
    .testimonial.active { display:block; animation:fadeIn 1s ease-in-out; }
    @keyframes fadeIn { from { opacity:0; } to { opacity:1; } }
    /* Contact form */
    .contact { padding:60px 20px; background:#f9f9f9; }
    .contact h3 { text-align:center; margin-bottom:1.5rem; font-size:1.8rem; color:#333; }
    .contact form { max-width:600px; margin:0 auto; display:flex; flex-direction:column; gap:0.6rem; }
    .contact input, .contact textarea { padding:0.5rem; border:1px solid #e0e0e0; border-radius:4px; font-size:1rem; }
    .contact button { background:#0066ff; color:#fff; border:none; padding:0.6rem 1.2rem; border-radius:4px; cursor:pointer; font-size:1rem; }
    .contact button:hover { filter:brightness(0.95); }
    @media (max-width:600px) {
      .hero h2 { font-size:1.8rem; }
    }
  </style>
</head>
<body>
  <header>
    <h1>${name}</h1>
    <nav>
      <ul>
        <li><a href="#">Home</a></li>
        <li><a href="#features">Features</a></li>
        <li><a href="#gallery">Gallery</a></li>
        <li><a href="#contact">Contact</a></li>
      </ul>
    </nav>
  </header>
  <section class="hero">
    <h2>${name}</h2>
    <p>${prompt}</p>
    <a href="#contact" class="cta-btn">Get Started</a>
  </section>
  <section id="features" class="features">
    <h3>Highlights</h3>
    <ul>
      ${featuresHTML}
    </ul>
  </section>
  <section id="gallery" class="gallery">
    <img src="${hero2}" alt="Gallery image one">
    <img src="${hero3}" alt="Gallery image two">
  </section>
  <section id="testimonials" class="testimonials">
    <h3>What our clients say</h3>
    <div class="testimonial-container">
      <div class="testimonial active">“This product changed my life!” – Jane</div>
      <div class="testimonial">“Excellent service and great value.” – John</div>
      <div class="testimonial">“Highly recommend to anyone.” – María</div>
    </div>
  </section>
  <section id="contact" class="contact">
    <h3>Contact Us</h3>
    <form onsubmit="event.preventDefault(); alert('Thank you! We will be in touch soon.');">
      <input type="text" placeholder="Your Name" required>
      <input type="email" placeholder="Your Email" required>
      <textarea placeholder="Your Message" required></textarea>
      <button type="submit">Send Message</button>
    </form>
  </section>
  <footer id="contact">
    <p>© ${new Date().getFullYear()} ${name}. All rights reserved.</p>
  </footer>
  <script>
    // Simple testimonials carousel.  Cycles through each testimonial every 4 seconds.
    (function() {
      var testimonials = document.querySelectorAll('.testimonial');
      var current = 0;
      setInterval(function() {
        testimonials[current].classList.remove('active');
        current = (current + 1) % testimonials.length;
        testimonials[current].classList.add('active');
      }, 4000);
    })();
  </script>
</body>
</html>`;
  }

  /**
   * Initialise event listeners and render the initial state.  This
   * function should be called once the DOM is ready.
   */
  function init() {
    // Navigation clicks
    navItems.forEach((item) => {
      item.addEventListener('click', () => {
        showView(item.dataset.view);
      });
    });
    // Shortcut from the dashboard to the new project form
    btnNew.addEventListener('click', () => {
      showView('new');
    });
    // Cancel button on new project form
    btnCancel.addEventListener('click', () => {
      showView('dashboard');
    });
    // Form submission for new project
    const form = document.getElementById('new-project-form');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = document.getElementById('project-name').value.trim();
      const prompt = document.getElementById('project-prompt').value.trim();
      if (!name || !prompt) return;
      const createProject = (html) => {
        const project = {
          id: Date.now(),
          name,
          prompt,
          html,
        };
        projects.push(project);
        saveProjects();
        form.reset();
        showView('dashboard');
        renderProjects();
      };
      // Attempt to call the assistant via the serverless function.  If it fails,
      // fall back to the built‑in HTML generator.
      generateViaAssistant(name, prompt)
        .then((html) => {
          createProject(html);
        })
        .catch(() => {
          const html = generateLandingHTML(name, prompt);
          createProject(html);
        });
    });
    // Render the initial list
    renderProjects();
    // Ensure dashboard is visible on load
    showView('dashboard');
  }

  // Initialise once the DOM content has loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();