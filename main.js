const isPackaged = () => !process.defaultApp;

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// Function declarations first
function getArgValue(flag) {
  const index = process.argv.indexOf(flag);
  return index !== -1 && index < process.argv.length - 1 ? process.argv[index + 1] : null;
}

// Then variable declarations using the function
let configPath = getArgValue('--config');

// Keep a global reference of the window object
let mainWindow;
let loginDetected = false;
let ocid = null;
let region = null;
let tenancyOcid = null;
let currentKeyType = null;
// Configure window visibility - set to false to keep window hidden, true to show
const SHOW_WINDOW = false;

// Use process.cwd() for the working directory where the app is run from
const appDir = process.cwd();
console.log(`App directory: ${appDir}`);

// Validate inputs function with improved config handling
function validateInputs() {
  console.log(`Running in packaged mode: ${isPackaged()}`);
  
  if (isPackaged()) {
    if (!configPath) {
      console.error('Error: --config argument is required in packaged mode');
      return false;
    }
    
    try {
      // Verify parent directory is writable
      const parentDir = path.dirname(path.resolve(configPath));
      fs.accessSync(parentDir, fs.constants.W_OK);
      console.log(`Config will be saved to: ${configPath}`);
    } catch (error) {
      console.error(`Invalid config path: ${configPath}`);
      console.error('Parent directory must exist and be writable');
      return false;
    }
  } else {
    // In development mode, just use current directory
    configPath = path.join(appDir, 'config');
    console.log(`Development mode - config will be saved to: ${configPath}`);
  }
  
  return true;
}

// Add a timeout to ensure the app doesn't run forever
setTimeout(() => {
  console.log('Maximum runtime exceeded. Forcing app to quit.');
  app.exit(1);
}, 10 * 60 * 1000); // 10 minutes max runtime

function createWindow() {
  if (!validateInputs()) {
    console.log('Validation failed, exiting app.');
    app.exit(1);
    return;
  }

  console.log('Creating browser window...');
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    title: 'Oracle Cloud Configuration Tool',
    show: true,
    webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        enableRemoteModule: false,
        webSecurity: false,
        partition: 'persist:oracle-cloud-session', // Unique partition name
        sandbox: false // disable sandbox to ensure executeJavaScript works in packaged mode
    }
  });

  // Add this before loading the URL to clear storage
  mainWindow.webContents.session.clearStorageData({
    storages: ['cookies', 'localstorage', 'sessionstorage', 'indexdb', 'websql']
  });

  // Remove the entire will-download handler from createWindow()
  // Replace with simplified version that only tracks key type
  mainWindow.webContents.session.on('will-download', (event, item) => {
    if (currentKeyType) {
        console.log(`Cancelling unexpected download for ${currentKeyType}`);
        item.cancel();
    }
  });

  mainWindow.loadURL('https://www.oracle.com/cloud/sign-in.html');
  console.log('Loading Oracle sign-in page...');

  // Listen for URL changes
  mainWindow.webContents.on('did-navigate', (event, url) => {
    checkForLoginSuccess(url);
  });

  mainWindow.webContents.on('did-navigate-in-page', (event, url) => {
    checkForLoginSuccess(url);
  });

  // Check URL continuously
  const urlCheckInterval = setInterval(() => {
    if (loginDetected || !mainWindow || mainWindow.isDestroyed()) {
      clearInterval(urlCheckInterval);
      return;
    }
    
    mainWindow.webContents.executeJavaScript('window.location.href', true)
      .then(currentUrl => {
        checkForLoginSuccess(currentUrl);
      })
      .catch(() => {
        // ignore errors
      });
  }, 250);

  // Function to check for login success
  function checkForLoginSuccess(url) {
    if (loginDetected) return;
    
    if (url) {
      const isLoggedIn = (url.startsWith('https://cloud.oracle.com/') && url.includes('region='));
        
      if (isLoggedIn) {
        loginDetected = true;
        
        // Only hide window based on visibility setting
        if (isPackaged() && !SHOW_WINDOW) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.webContents.openDevTools();
        }
        
        const urlObj = new URL(url);
        region = urlObj.searchParams.get('region');
        console.log(`User logged in to region: ${region}`);
        
        const profileUrl = `https://cloud.oracle.com/identity/domains/my-profile`;
        mainWindow.loadURL(profileUrl);
        
        function checkForOCID() {
          mainWindow.webContents.executeJavaScript(`
            (function() {
              try {
                const iframe = document.querySelector('iframe[src*="maui-preact"]');
                if (iframe) {
                  const doc = iframe.contentDocument || iframe.contentWindow.document;
                  const ocidElement = doc.querySelector('[data-test-id="jet-meta-label-1-text-container"] bdi');
                  return ocidElement ? ocidElement.textContent : null;
                }
                return document.querySelector('[data-test-id="jet-meta-label-1-text-container"] bdi')?.textContent;
              } catch(e) {
                return null;
              }
            })()
          `).then(userOcid => {
            if (userOcid && userOcid.startsWith('ocid1.user')) {
              ocid = userOcid; // Store to global variable
              console.log('User OCID:', ocid);
              
              // Navigate to API keys page FIRST before getting tenancy
              console.log('Proceeding to API key setup...');
              const apiKeyUrl = 'https://cloud.oracle.com/identity/domains/my-profile/auth-tokens';
              mainWindow.loadURL(apiKeyUrl);
              
              // Start monitoring for API key button
              setTimeout(() => {
                clickAddApiKeyButton();
              }, 5000);
            } else {
              console.log('Retrying OCID detection...');
              setTimeout(checkForOCID, 1000);
            }
          }).catch(err => {
            console.error('Error checking for OCID:', err);
            setTimeout(checkForOCID, 2000);
          });
        }

        setTimeout(checkForOCID, 5000);
        clearInterval(urlCheckInterval);
      }
    }
  }

  mainWindow.on('closed', function () {
    mainWindow = null;
    if (!loginDetected) {
      app.exit(0);
    }
  });

  // Add this to clear cache on exit
  app.on('before-quit', () => {
    mainWindow.webContents.session.clearCache();
    mainWindow.webContents.session.clearStorageData();
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin' && !loginDetected) {
    app.exit(0);
  }
});

app.on('activate', function () {
  if (mainWindow === null && !loginDetected) {
    if (validateInputs()) {
      createWindow();
    } else {
      app.exit(0);
    }
  }
});

// Add these functions to handle API key interaction
function clickAddApiKeyButton() {
  function checkButton() {
    mainWindow.webContents.executeJavaScript(`
      (function() {
        try {
          const iframe = document.querySelector('iframe[src*="maui-preact"]');
          let button;
          if (iframe) {
            const doc = iframe.contentDocument || iframe.contentWindow.document;
            button = doc.querySelector('button[aria-label="Add API key"]');
          }
          if (!button) { // Fallback to main document if not in iframe or iframe not found
            button = document.querySelector('button[aria-label="Add API key"]');
          }
          
          if (button) {
            button.click();
            return true;
          }
          return false;
        } catch(e) {
          console.error('Error in clickAddApiKeyButton JS execution:', e);
          return false;
        }
      })()
    `).then(clicked => {
      if (clicked) {
        console.log('Add API key button clicked');
        setTimeout(() => handleKeySelection(), 3000); // Wait for modal to open
        if (!isPackaged()) { // Keep window visible in dev
            mainWindow.show();
            mainWindow.webContents.openDevTools();
        }
      } else {
        console.log('Add API key button not found, retrying...');
        setTimeout(checkButton, 1000);
      }
    }).catch(err => {
        console.error('Error executing JS for Add API Key button:', err);
        setTimeout(checkButton, 1000)
    });
  }
  setTimeout(checkButton, 5000); // Initial delay before first check
}

// Update handleKeySelection to go straight to key generation/upload
async function handleKeySelection() {
    // Remove spinners first
    await mainWindow.webContents.executeJavaScript(`
        (function() {
            try {
                const iframe = document.querySelector('iframe[src*="maui-preact"]');
                const doc = iframe ? iframe.contentDocument : document;
                const spinners = doc.querySelectorAll('.modal-loader, .ProgressCircleBaseTheme_baseTheme__1qsbny60');
                spinners.forEach(s => s.parentNode.removeChild(s));
                return true;
            } catch(e) {
                return false;
            }
        })()
    `);
    
    // Generate keys and upload directly
    console.log("Generating and uploading API keys...");
    await generateAndUploadKeys();
}

// Improve the generateAndUploadKeys function for better UI interaction
async function generateAndUploadKeys() {
    try {
        // Generate fresh key pair and store fingerprint globally
        const { publicKey, fingerprint: calculatedFingerprint } = await generateKeyPair();
        fingerprint = calculatedFingerprint; // Store globally
        
        // Enhanced spinner removal
        await removeAllSpinners();
        
        // More robust radio button selection
        console.log('Attempting to select "Paste public key" option...');
        const radioSuccess = await clickPastePublicKeyRadio();
        
        if (!radioSuccess) {
            console.error('Failed to select paste public key option after multiple attempts');
            throw new Error('Failed to select paste public key option');
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000));
        await removeAllSpinners();
        
        // Better textarea handling
        console.log('Attempting to paste public key into textarea...');
        let pasteSuccess = false;
        let pasteAttempts = 5; // Increase retries
        
        while (!pasteSuccess && pasteAttempts > 0) {
            await removeAllSpinners();
            
            pasteSuccess = await mainWindow.webContents.executeJavaScript(`
                (function(publicKey) {
                    try {
                        console.log("Finding textarea for public key...");
                        const iframe = document.querySelector('iframe[src*="maui-preact"]');
                        if (!iframe) {
                            console.error('Maui iframe not found');
                            return false;
                        }
                        
                        const doc = iframe.contentDocument || iframe.contentWindow.document;
                        
                        // Try multiple methods to find the textarea
                        let textarea = null;
                        
                        // Method 1: By direct aria-label
                        textarea = doc.querySelector('textarea[aria-label="Public key"]');
                        console.log("Method 1 result:", !!textarea);
                        
                        // Method 2: By role and label text
                        if (!textarea) {
                            const labels = Array.from(doc.querySelectorAll('label')).filter(l => 
                                l.textContent.includes('Public key') || 
                                l.textContent.includes('Paste public key')
                            );
                            if (labels.length > 0) {
                                // Try to find the textarea associated with this label
                                const id = labels[0].getAttribute('for');
                                if (id) textarea = doc.getElementById(id);
                            }
                            console.log("Method 2 result:", !!textarea);
                        }
                        
                        // Method 3: Find by textarea tag and a specific class part
                        if (!textarea) {
                            textarea = doc.querySelector('textarea[class*="TextFieldInputStyles_textFieldInputBase__"]');
                             console.log("Method 3 result:", !!textarea);
                        }

                        // Method 4: Find any textarea in the form
                        if (!textarea) {
                            const allTextareas = doc.querySelectorAll('textarea');
                            console.log("Found", allTextareas.length, "textareas");
                            if (allTextareas.length > 0) {
                                textarea = allTextareas[0];
                            }
                        }
                        
                        if (textarea) {
                            console.log("Setting textarea value...");
                            textarea.value = publicKey;
                            textarea.dispatchEvent(new Event('input', { bubbles: true }));
                            textarea.dispatchEvent(new Event('change', { bubbles: true }));
                            return true;
                        } else {
                            console.error("No textarea found with any method");
                            return false;
                        }
                    } catch(e) {
                        console.error('Textarea error:', e);
                        return false;
                    }
                })(${JSON.stringify(publicKey)})
            `);
            
            if (!pasteSuccess) {
                pasteAttempts--;
                console.log(`Retrying textarea paste (${pasteAttempts} retries left)...`);
                await new Promise(resolve => setTimeout(resolve, 1500)); // Longer wait between attempts
            }
        }
        
        if (!pasteSuccess) {
            throw new Error('Failed to paste public key into textarea');
        }
        
        // Wait and remove spinners again
        await new Promise(resolve => setTimeout(resolve, 1500));
        await removeAllSpinners();
        
        // Improved Add button logic
        console.log('Attempting to click Add button...');
        const addClicked = await clickAddButton();
        
        if (!addClicked) {
            throw new Error('Failed to click Add button');
        }

        // NEW: Verify fingerprint matches
        console.log('Waiting for fingerprint confirmation...');
        const fingerprintMatch = await verifyFingerprintMatch();
        if (!fingerprintMatch) {
            throw new Error('Fingerprint mismatch detected');
        }
        
        // Proceed to tenancy OCID
        console.log('Proceeding to fetch tenancy details...');
        const tenancyUrl = `https://cloud.oracle.com/tenancy`;
        mainWindow.loadURL(tenancyUrl);
        setTimeout(checkForTenancyOCID, 8000);
    } catch (error) {
        console.error('Key generation/upload failed:', error);
        process.exit(1);
    }
}

// Enhanced spinner removal
async function removeAllSpinners() {
    console.log('Removing any spinners...');
    return mainWindow.webContents.executeJavaScript(`
        (function() {
            try {
                const removeFromDoc = (doc) => {
                    if (!doc) return;
                    const spinnerSelectors = [
                        '.modal-loader', 
                        '.ProgressCircleBaseTheme_baseTheme__1qsbny60', 
                        '.loading-indicator',
                        '.spinner',
                        '[role="progressbar"]'
                    ];
                    
                    spinnerSelectors.forEach(selector => {
                        const elements = doc.querySelectorAll(selector);
                        console.log('Found ' + elements.length + ' elements matching ' + selector);
                        elements.forEach(s => {
                            try {
                                if (s && s.parentNode) s.parentNode.removeChild(s);
                            } catch(e) {}
                        });
                    });
                };
                
                // Remove from main document
                removeFromDoc(document);
                
                // Remove from all iframes
                const iframes = document.querySelectorAll('iframe');
                for (const iframe of iframes) {
                    try {
                        if (iframe.contentDocument) {
                            removeFromDoc(iframe.contentDocument);
                        }
                    } catch(e) {}
                }
                
                return true;
            } catch(e) {
                console.error('Error removing spinners:', e);
                return false;
            }
        })()
    `);
}

// Helper functions for UI interaction
async function clickPastePublicKeyRadio() {
    for (let attempt = 0; attempt < 5; attempt++) {  // Increased attempts
        console.log(`Radio button selection attempt ${attempt+1}/5...`);
        
        // Remove spinners first
        await removeAllSpinners();
        
        const clicked = await mainWindow.webContents.executeJavaScript(`
            (function() {
                try {
                    // Try multiple methods to find and click the paste radio button
                    const iframe = document.querySelector('iframe[src*="maui-preact"]');
                    if (!iframe) {
                        console.error('Radio selection: iframe not found');
                        return false;
                    }
                    
                    const doc = iframe.contentDocument || iframe.contentWindow.document;
                    
                    // More debug info about radio buttons
                    const allRadios = doc.querySelectorAll('input[type="radio"]');
                    console.log('Found ' + allRadios.length + ' radio buttons in total');
                    
                    // Method 1: Find by value attribute - most specific
                    let radioInput = doc.querySelector('input[type="radio"][value="text"]');
                    console.log('Method 1 result:', !!radioInput);
                    
                    // Method 2: Find by aria-label
                    if (!radioInput) {
                        const elements = doc.querySelectorAll('input[type="radio"]');
                        radioInput = Array.from(elements).find(el => {
                            // Check aria-label or nearby label text
                            const label = el.closest('label') || 
                                doc.querySelector('label[for="' + el.id + '"]');
                            return label && (
                                label.textContent.includes('Paste') || 
                                label.textContent.includes('public key')
                            );
                        });
                        console.log('Method 2 result:', !!radioInput);
                    }
                    
                    // Method 3: Find by position (third radio is the paste option)
                    if (!radioInput && allRadios.length >= 3) {
                        radioInput = allRadios[2]; // Third radio is "paste"
                        console.log('Method 3 (positional) result:', !!radioInput);
                    }
                    
                    if (radioInput) {
                        console.log('Found paste public key radio button, clicking...');
                        
                        // Try multiple click techniques for maximum reliability
                        try {
                            // 1. Native click
                            radioInput.click();
                            
                            // 2. Dispatch mousedown/up events
                            radioInput.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
                            radioInput.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
                            
                            // 3. Set checked and dispatch change
                            radioInput.checked = true;
                            radioInput.dispatchEvent(new Event('change', { bubbles: true }));
                            
                            console.log('Radio selection: After click checked=', radioInput.checked);
                            return true;
                        } catch(e) {
                            console.error('Radio click error:', e);
                            return false;
                        }
                    }
                    
                    return false;
                } catch(e) {
                    console.error('Radio selection error:', e);
                    return false;
                }
            })()
        `);
        
        if (clicked) return true;
        
        // Longer wait between attempts
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    return false;
}

async function clickAddButton() {
    for (let attempt = 0; attempt < 3; attempt++) {
        const clicked = await mainWindow.webContents.executeJavaScript(`
            (function() {
                try {
                    const iframe = document.querySelector('iframe[src*="maui-preact"]');
                    if (!iframe) return false;
                    
                    const doc = iframe.contentDocument || iframe.contentWindow.document;
                    
                    // Updated button selectors to match the specific Add button
                    const buttonSelectors = [
                        'button[aria-label="Add"]',  // Primary selector
                        'button[type="button"]',     // Match type="button"
                        'button.BaseButtonStyles_styles_base__jvi3ds0' // Match base class
                    ];
                    
                    for (const selector of buttonSelectors) {
                        const buttons = Array.from(doc.querySelectorAll(selector)).filter(b => 
                            b.textContent.trim() === 'Add' &&  // Exact match
                            !b.disabled &&
                            b.offsetParent !== null  // Ensure visible
                        );
                        
                        if (buttons.length > 0) {
                            console.log('Found Add button, clicking...');
                            buttons[0].click();
                            return true;
                        }
                    }
                    
                    return false;
                } catch(e) {
                    console.error('Add button error:', e);
                    return false;
                }
            })()
        `);
        
        if (clicked) return true;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    return false;
}

// Fix the saveConfigFile function to properly handle the path and use stored fingerprint
function saveConfigFile(tenancyOcid) {
    try {
        // Use stored global fingerprint instead of recalculating
        if (!fingerprint) {
            console.error('Fingerprint not available');
            process.exit(1);
        }
        
        const privateKeyPath = path.join(appDir, 'private.pem');
        
        // Format paths for Windows compatibility
        const formattedKeyPath = privateKeyPath.replace(/\\/g, '/');
        
        // Create config content with all required fields
        const configContent = `[DEFAULT]
user=${ocid}
fingerprint=${fingerprint}
key_file=${formattedKeyPath}
tenancy=${tenancyOcid}
region=${region}`;

        // Try to save config file to the path specified
        console.log(`Saving config to: ${configPath}`);
        fs.writeFileSync(configPath, configContent);
        console.log(`Config file successfully saved to: ${configPath}`);
        
        // All done, exit the app
        console.log('All processing complete. Exiting application...');
        setTimeout(() => {
            app.exit(0);
        }, 1000);
        
    } catch (error) {
        console.error('Error creating config file:', error);
        process.exit(1);
    }
}

// Generate RSA key pair directly
function generateKeyPair() {
    return new Promise((resolve, reject) => {
        try {
            const crypto = require('crypto');
            const fs = require('fs');
            const path = require('path');
            
            console.log('Generating fresh RSA key pair...');
            
            // Generate a new 2048-bit RSA key pair
            crypto.generateKeyPair('rsa', {
                modulusLength: 2048,
                publicKeyEncoding: {
                    type: 'spki',
                    format: 'pem'
                },
                privateKeyEncoding: {
                    type: 'pkcs8',
                    format: 'pem'
                }
            }, (err, publicKey, privateKey) => {
                if (err) {
                    console.error('Key generation error:', err);
                    reject(err);
                    return;
                }
                
                // Format keys exactly as specified
                const formattedPrivateKey = 
                    '-----BEGIN PRIVATE KEY-----\n' +
                    privateKey
                        .replace(/-----BEGIN PRIVATE KEY-----/g, '')
                        .replace(/-----END PRIVATE KEY-----/g, '')
                        .replace(/\n+/g, '') // Remove existing newlines
                        .match(/.{1,64}/g).join('\n') + 
                    '\n-----END PRIVATE KEY-----\nOCI_API_KEY\n';
                
                const formattedPublicKey = 
                    '-----BEGIN PUBLIC KEY-----\n' +
                    publicKey
                        .replace(/-----BEGIN PUBLIC KEY-----/g, '')
                        .replace(/-----END PUBLIC KEY-----/g, '')
                        .replace(/\n+/g, '') // Remove existing newlines
                        .match(/.{1,64}/g).join('\n') + 
                    '\n-----END PUBLIC KEY-----\n';

                // Save formatted keys
                const privateKeyPath = path.join(appDir, 'private.pem');
                const publicKeyPath = path.join(appDir, 'public.pem');
                
                fs.writeFileSync(privateKeyPath, formattedPrivateKey);
                fs.writeFileSync(publicKeyPath, formattedPublicKey);
                
                console.log('Successfully generated and saved key pair:');
                console.log(`- Private key: ${privateKeyPath}`);
                console.log(`- Public key: ${publicKeyPath}`);
                
                // Calculate fingerprint for reference
                const derBuf = crypto.createPublicKey(publicKey)
                    .export({ type: 'spki', format: 'der' });
                const hash = crypto.createHash('md5').update(derBuf).digest('hex');
                const fingerprintValue = hash.match(/.{2}/g).join(':');
                
                console.log(`Key fingerprint: ${fingerprintValue}`);
                // Store fingerprint globally
                fingerprint = fingerprintValue;
                
                resolve({ publicKey, privateKey, fingerprint: fingerprintValue });
            });
        } catch (error) {
            console.error('Error in generateKeyPair:', error);
            reject(error);
        }
    });
}

// Update checkForTenancyOCID to save config file
function checkForTenancyOCID() {
  console.log('Attempting to fetch tenancy OCID...');
  
  mainWindow.webContents.executeJavaScript(`
    (function() {
      try {
        // Remove any spinners first
        const iframe = document.querySelector('iframe[src*="maui-preact"]');
        if (iframe && iframe.contentDocument) {
          iframe.contentDocument.querySelectorAll('.modal-loader, .ProgressCircleBaseTheme_baseTheme__1qsbny60')
            .forEach(s => s.parentNode.removeChild(s));
        }
        
        // Try to find tenancy OCID in various locations
        let ta = document.querySelector('textarea[aria-hidden="true"]');
        if (ta) {
          const value = ta.textContent || ta.value;
          if (value && value.startsWith('ocid1.tenancy')) return value.trim();
        }
        
        // Check in iframes
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
          try {
            const doc = iframe.contentDocument;
            ta = doc.querySelector('textarea[aria-hidden="true"]');
            if (ta) {
              const value = ta.textContent || ta.value;
              if (value && value.startsWith('ocid1.tenancy')) return value.trim();
            }
            
            // Also look for div with data-test-id pattern containing tenancy OCID
            const ocidDivs = doc.querySelectorAll('div[data-test-id*="ocid"]');
            for (const div of ocidDivs) {
              if (div.textContent && div.textContent.startsWith('ocid1.tenancy')) {
                return div.textContent.trim();
              }
            }
          } catch(e) {}
        }
        return null;
      } catch(e) {
        console.error('Error in tenancy OCID detection:', e);
        return null;
      }
    })()
  `, true).then(tenancyOcid => {
    if (tenancyOcid) {
      console.log('Tenancy OCID:', tenancyOcid);
      saveConfigFile(tenancyOcid);
    } else {
      console.log('Tenancy OCID not found - retrying...');
      setTimeout(checkForTenancyOCID, 1000);
    }
  }).catch(err => {
    console.error('Error checking for tenancy OCID:', err);
    setTimeout(checkForTenancyOCID, 1000);
  });
}

// Update generatePublicKeyFromPrivate to handle potential issues
function generatePublicKeyFromPrivate() {
  try {
    const crypto = require('crypto');
    const fs = require('fs');
    const path = require('path');

    const privateKeyPath = path.join(appDir, 'private.pem');
    const publicKeyPath = path.join(appDir, 'public.pem');

    // Read private key and verify
    const privateKeyPem = fs.readFileSync(privateKeyPath, 'utf8');
    
    if (!privateKeyPem.includes('BEGIN PRIVATE KEY')) {
      console.error('Invalid private key format');
      return false;
    }
    
    // Log a snippet for debugging
    console.log('Private key snippet:', privateKeyPem.substring(0, 50) + '...');
    
    // Create public key
    const privateKey = crypto.createPrivateKey(privateKeyPem);
    const publicKey = crypto.createPublicKey(privateKey);
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });

    // Save public key
    fs.writeFileSync(publicKeyPath, publicKeyPem);
    console.log(`Successfully generated public key from private key at ${publicKeyPath}`);

    return true;
  } catch (error) {
    console.error('Error generating public key:', error);
    // Try to diagnose the issue
    try {
      const fs = require('fs');
      const path = require('path');
      const privateKeyPath = path.join(appDir, 'private.pem');
      
      if (fs.existsSync(privateKeyPath)) {
        const content = fs.readFileSync(privateKeyPath, 'utf8');
        console.error('Private key file content:', content);
      } else {
        console.error('Private key file does not exist');
      }
    } catch (err) {
      console.error('Error examining private key file:', err);
    }
    return false;
  }
}

// UPDATED FUNCTION: Verify fingerprint matches with infinite retries
async function verifyFingerprintMatch() {
    return new Promise(async (resolve) => {
        async function checkFingerprint() {
            try {
                const websiteFingerprint = await mainWindow.webContents.executeJavaScript(`
                    (function() {
                        try {
                            const iframe = document.querySelector('iframe[src*="maui-preact"]');
                            const doc = iframe ? iframe.contentDocument : document;
                            
                            // Try multiple selector strategies to find the fingerprint
                            let element = null;
                            
                            // Method 1: By role and class
                            element = doc.querySelector('div[role="textbox"][class*="ReadonlyTextFieldInputStyles_readOnlyTextFieldInputBase"]');
                            
                            // Method 2: Find a label with "Fingerprint" text and then find its related textbox
                            if (!element) {
                                const labels = Array.from(doc.querySelectorAll('label')).filter(l => 
                                    l.textContent.trim() === 'Fingerprint'
                                );
                                
                                if (labels.length > 0) {
                                    const labelId = labels[0].id;
                                    if (labelId) {
                                        element = doc.querySelector(\`div[aria-labelledby="\${labelId}"]\`);
                                    }
                                }
                            }
                            
                            // Method 3: Just find any element containing a fingerprint pattern
                            if (!element) {
                                const allElements = doc.querySelectorAll('div[role="textbox"]');
                                element = Array.from(allElements).find(el => {
                                    const text = el.textContent.trim();
                                    return text.match(/([0-9a-f]{2}:){15}[0-9a-f]{2}/i);
                                });
                            }
                            
                            console.log("Fingerprint element found:", !!element);
                            return element ? element.textContent.trim() : null;
                        } catch(e) {
                            console.error("Error in fingerprint detection:", e);
                            return null;
                        }
                    })()
                `);

                if (websiteFingerprint) {
                    console.log('Website fingerprint:', websiteFingerprint);
                    console.log('Our fingerprint:', fingerprint);
                    
                    if (websiteFingerprint.replace(/\s/g, '') === fingerprint.replace(/\s/g, '')) {
                        console.log('Fingerprints match!');
                        return resolve(true);
                    }
                    
                    console.error('FINGERPRINT MISMATCH!');
                    console.error('Expected:', fingerprint);
                    console.error('Received:', websiteFingerprint);
                    return resolve(false);
                }

                console.log('Fingerprint element not found yet, retrying...');
                setTimeout(checkFingerprint, 1500);
            } catch (error) {
                console.error('Error verifying fingerprint:', error);
                setTimeout(checkFingerprint, 1500);
            }
        }

        checkFingerprint();
    });
}