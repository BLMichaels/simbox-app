/**
 * SimBox Bridge - JavaScript to inject into Storyline player
 * This script enables remote control of the Storyline simulation from mobile devices
 */

(function() {
  'use strict';

  // Configuration — override via window.SIMBOX_WS_SERVER before this script loads
  const WS_SERVER = window.SIMBOX_WS_SERVER || 'ws://localhost:3001';
  // Set window.SIMBOX_SHOW_MOBILE_UI = true before this script to show phone pairing UI
  const SHOW_MOBILE_UI = window.SIMBOX_SHOW_MOBILE_UI === true;
  let ws = null;
  let isConnected = false;
  let connectionCode = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 5;
  let scanDebounceTimer = null;
  let domObserver = null;

  function debouncedScanForButtons(delay = 400) {
    clearTimeout(scanDebounceTimer);
    scanDebounceTimer = setTimeout(scanForButtons, delay);
  }

  function startDomObserver() {
    if (domObserver || !document.body) return;

    domObserver = new MutationObserver((mutations) => {
      if (!isConnected) return;

      const relevant = mutations.some((mutation) =>
        mutation.type === 'childList' ||
        (mutation.type === 'attributes' &&
          ['class', 'style', 'hidden', 'aria-hidden'].includes(mutation.attributeName))
      );

      if (relevant) {
        debouncedScanForButtons(500);
      }
    });

    domObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
    });
  }

  // UI Elements
  let codeDisplay = null;
  let connectionStatus = null;
  let controlPanel = null;

  // Initialize the bridge (deprecated - use initUI instead)
  function init() {
    initUI();
  }

  // Create UI overlay for code display and status
  function createUI() {
    // Check if UI already exists
    const existing = document.getElementById('simbox-bridge-container');
    if (existing) {
      console.log('SimBox Bridge: UI already exists, removing old one');
      existing.remove();
    }

    // Wait for body to exist
    if (!document.body) {
      console.log('SimBox Bridge: Waiting for body...');
      setTimeout(createUI, 100);
      return;
    }

    console.log('SimBox Bridge: Creating UI...');

    // Create container
    const container = document.createElement('div');
    container.id = 'simbox-bridge-container';
    container.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 10000;
      background: rgba(0, 0, 0, 0.85);
      color: white;
      padding: 20px;
      border-radius: 10px;
      font-family: Arial, sans-serif;
      min-width: 250px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
      transition: all 0.3s ease;
    `;

    // Minimize button
    const minimizeBtn = document.createElement('button');
    minimizeBtn.type = 'button';
    minimizeBtn.className = 'simbox-minimize-btn';
    minimizeBtn.innerHTML = '−';
    minimizeBtn.style.cssText = `
      position: absolute;
      top: 5px;
      right: 5px;
      background: rgba(255, 255, 255, 0.2);
      border: none;
      color: white;
      width: 24px;
      height: 24px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    `;
    minimizeBtn.title = 'Minimize';
    minimizeBtn.onclick = () => {
      container.classList.toggle('minimized');
      if (container.classList.contains('minimized')) {
        minimizeBtn.innerHTML = '+';
        minimizeBtn.title = 'Expand';
      } else {
        minimizeBtn.innerHTML = '−';
        minimizeBtn.title = 'Minimize';
      }
    };

    // Back to case home page
    function getHomeUrl() {
      if (window.SIMBOX_HOME_URL) return window.SIMBOX_HOME_URL;
      try {
        return `${window.location.origin}/`;
      } catch (_error) {
        return '/';
      }
    }

    const homeBtn = document.createElement('a');
    homeBtn.className = 'simbox-home-btn';
    homeBtn.href = getHomeUrl();
    homeBtn.textContent = '← All cases';
    homeBtn.title = 'Back to SimBox home';
    homeBtn.style.cssText = `
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-top: 14px;
      padding: 8px 12px;
      width: 100%;
      box-sizing: border-box;
      background: rgba(79, 189, 244, 0.18);
      border: 1px solid rgba(79, 189, 244, 0.55);
      border-radius: 6px;
      color: #4FBDF4;
      text-decoration: none;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.02em;
      cursor: pointer;
      transition: background 0.2s ease;
    `;
    homeBtn.onmouseenter = () => {
      homeBtn.style.background = 'rgba(79, 189, 244, 0.3)';
    };
    homeBtn.onmouseleave = () => {
      homeBtn.style.background = 'rgba(79, 189, 244, 0.18)';
    };

    // Always-visible home control (works even when panel is minimized)
    const floatingHome = document.createElement('a');
    floatingHome.id = 'simbox-floating-home';
    floatingHome.href = getHomeUrl();
    floatingHome.textContent = '← Cases';
    floatingHome.title = 'Back to SimBox home';
    floatingHome.style.cssText = `
      position: fixed;
      top: 20px;
      left: 20px;
      z-index: 10000;
      padding: 10px 14px;
      background: rgba(0, 0, 0, 0.82);
      border: 1px solid rgba(79, 189, 244, 0.55);
      border-radius: 8px;
      color: #4FBDF4;
      text-decoration: none;
      font-family: Arial, sans-serif;
      font-size: 13px;
      font-weight: 600;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
      transition: background 0.2s ease, transform 0.2s ease;
    `;
    floatingHome.onmouseenter = () => {
      floatingHome.style.background = 'rgba(20, 40, 55, 0.95)';
      floatingHome.style.transform = 'translateY(-1px)';
    };
    floatingHome.onmouseleave = () => {
      floatingHome.style.background = 'rgba(0, 0, 0, 0.82)';
      floatingHome.style.transform = 'translateY(0)';
    };

    // Connection code display
    const codeLabel = document.createElement('div');
    codeLabel.className = 'simbox-code-label';
    codeLabel.textContent = 'Connection Code:';
    codeLabel.style.cssText = 'font-size: 12px; margin-bottom: 5px; opacity: 0.8; padding-right: 24px;';

    codeDisplay = document.createElement('div');
    codeDisplay.id = 'simbox-code-display';
    codeDisplay.style.cssText = `
      font-size: 32px;
      font-weight: bold;
      letter-spacing: 5px;
      text-align: center;
      margin: 10px 0;
      color: #4FBDF4;
      font-family: 'Courier New', monospace;
    `;
    codeDisplay.textContent = '---';

    // Status display
    connectionStatus = document.createElement('div');
    connectionStatus.id = 'simbox-status';
    connectionStatus.style.cssText = 'font-size: 11px; margin-top: 10px; text-align: center;';
    connectionStatus.textContent = 'Connecting...';

    // Instructions
    const instructions = document.createElement('div');
    instructions.className = 'simbox-instructions';
    instructions.style.cssText = 'font-size: 10px; margin-top: 15px; opacity: 0.7; line-height: 1.4;';
    instructions.innerHTML = 'Enter this code in the SimBox app on your mobile device to connect.';

    container.appendChild(minimizeBtn);
    container.appendChild(codeLabel);
    container.appendChild(codeDisplay);
    container.appendChild(connectionStatus);
    container.appendChild(instructions);
    container.appendChild(homeBtn);

    // Add CSS for minimized state
    const style = document.createElement('style');
    style.textContent = `
      #simbox-bridge-container.minimized {
        min-width: auto;
        width: 8px;
        height: 8px;
        padding: 0;
        border-radius: 50%;
        background: rgba(76, 175, 80, 0.6);
        border: 2px solid rgba(76, 175, 80, 0.9);
        box-shadow: 0 0 8px rgba(76, 175, 80, 0.5);
        cursor: pointer;
        overflow: visible;
      }
      #simbox-bridge-container.minimized:hover {
        width: 160px;
        height: auto;
        padding: 8px;
        border-radius: 6px;
        background: rgba(0, 0, 0, 0.9);
        border: 1px solid rgba(76, 175, 80, 0.9);
      }
      #simbox-bridge-container.minimized .simbox-code-label,
      #simbox-bridge-container.minimized #simbox-code-display,
      #simbox-bridge-container.minimized .simbox-instructions,
      #simbox-bridge-container.minimized .simbox-home-btn,
      #simbox-bridge-container.minimized .simbox-minimize-btn {
        display: none;
      }
      #simbox-bridge-container.minimized:hover .simbox-minimize-btn {
        display: flex;
        position: absolute;
        top: 2px;
        right: 2px;
        width: 18px;
        height: 18px;
        font-size: 14px;
      }
      #simbox-bridge-container.minimized:hover .simbox-home-btn {
        display: inline-flex;
        margin-top: 4px;
        padding: 6px 8px;
        font-size: 11px;
      }
      #simbox-bridge-container.minimized #simbox-status {
        display: none;
      }
      #simbox-bridge-container.minimized:hover #simbox-status {
        display: block;
        font-size: 10px;
        margin-top: 5px;
        text-align: center;
        color: #4CAF50;
      }
    `;
    document.head.appendChild(style);

    try {
      const oldFloating = document.getElementById('simbox-floating-home');
      if (oldFloating) oldFloating.remove();
      document.body.appendChild(floatingHome);
      document.body.appendChild(container);
      console.log('SimBox Bridge: UI created and appended to body');
      console.log('SimBox Bridge: Container element:', container);
      console.log('SimBox Bridge: Container visible:', window.getComputedStyle(container).display !== 'none');
      console.log('SimBox Bridge: Container z-index:', window.getComputedStyle(container).zIndex);

      // Phone pairing panel — hidden unless SIMBOX_SHOW_MOBILE_UI is true
      if (SHOW_MOBILE_UI) {
        container.style.display = 'block';
        container.style.visibility = 'visible';
        container.style.opacity = '1';
      } else {
        container.style.display = 'none';
        container.setAttribute('aria-hidden', 'true');
        container.setAttribute('hidden', '');
        console.log('SimBox Bridge: Mobile control UI hidden (set window.SIMBOX_SHOW_MOBILE_UI = true to show)');
      }
    } catch (e) {
      console.error('SimBox Bridge: Error appending UI to body:', e);
      // Try again after a short delay
      setTimeout(() => {
        try {
          document.body.appendChild(floatingHome);
          document.body.appendChild(container);
          if (SHOW_MOBILE_UI) {
            container.style.display = 'block';
            container.style.visibility = 'visible';
            container.style.opacity = '1';
          } else {
            container.style.display = 'none';
            container.setAttribute('hidden', '');
          }
          console.log('SimBox Bridge: UI created on retry');
        } catch (e2) {
          console.error('SimBox Bridge: Failed to create UI:', e2);
        }
      }, 500);
    }
  }

  // Connect to WebSocket server
  function connectToServer() {
    try {
      ws = new WebSocket(WS_SERVER);

      ws.onopen = () => {
        console.log('SimBox Bridge: Connected to server');
        reconnectAttempts = 0;
        registerAsHost();
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleMessage(data);
        } catch (error) {
          console.error('SimBox Bridge: Error parsing message', error);
        }
      };

      ws.onerror = (error) => {
        console.error('SimBox Bridge: WebSocket error', error);
        updateStatus('Connection error', 'error');
      };

      ws.onclose = () => {
        console.log('SimBox Bridge: Connection closed');
        isConnected = false;
        updateStatus('Disconnected', 'error');
        
        // Attempt to reconnect
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++;
          setTimeout(() => {
            console.log(`SimBox Bridge: Reconnecting (attempt ${reconnectAttempts})...`);
            connectToServer();
          }, 2000 * reconnectAttempts);
        } else {
          updateStatus('Connection failed. Please refresh the page.', 'error');
        }
      };
    } catch (error) {
      console.error('SimBox Bridge: Failed to connect', error);
      updateStatus('Failed to connect to server', 'error');
    }
  }

  // Register as host and get connection code
  function registerAsHost() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'host-register'
      }));
    }
  }

  // Handle incoming messages
  function handleMessage(data) {
    switch (data.type) {
      case 'code-generated':
        connectionCode = data.code;
        codeDisplay.textContent = data.code;
        updateStatus('Waiting for mobile connection...', 'waiting');
        break;

      case 'mobile-connected':
        isConnected = true;
        updateStatus('✓ Mobile device connected', 'connected');
        
        // Minimize the connection window after connection
        setTimeout(() => {
          const container = document.getElementById('simbox-bridge-container');
          if (container && !container.classList.contains('minimized')) {
            container.classList.add('minimized');
            const minimizeBtn = container.querySelector('button');
            if (minimizeBtn) {
              minimizeBtn.innerHTML = '+';
              minimizeBtn.title = 'Expand';
            }
          }
        }, 2000); // Wait 2 seconds after connection to minimize
        
        startDomObserver();
        debouncedScanForButtons(1000);
        if (window.simboxScanInterval) {
          clearInterval(window.simboxScanInterval);
        }
        window.simboxScanInterval = setInterval(() => {
          if (isConnected) {
            debouncedScanForButtons(100);
          }
        }, 5000);
        break;

      case 'mobile-disconnected':
        isConnected = false;
        updateStatus('Mobile device disconnected', 'waiting');
        if (window.simboxScanInterval) {
          clearInterval(window.simboxScanInterval);
          window.simboxScanInterval = null;
        }
        break;

      case 'control-action':
        handleControlAction(data.action, data.data);
        break;

      case 'get-available-buttons':
        sendAvailableButtons();
        break;

      default:
        console.log('SimBox Bridge: Unknown message type', data.type);
    }
  }

  // Handle control actions from mobile
  function handleControlAction(action, actionData) {
    console.log('SimBox Bridge: Handling action', action, actionData);

    try {
      const player = GetPlayer();
      if (!player) {
        console.error('SimBox Bridge: Player not found');
        return;
      }

      switch (action) {
        case 'click-button':
          // Find and click a button by ID or text
          if (actionData.buttonId || actionData.buttonText) {
            let clicked = false;
            let targetElement = null;
            
            console.log('SimBox Bridge: Attempting to click button:', actionData.buttonId, actionData.buttonText);
            
            // Special handling for player control buttons
            if (actionData.buttonId === 'storyline-next-button' || actionData.buttonText === 'Next') {
              try {
                const playerObj = player.GetPlayer ? player.GetPlayer() : player;
                if (playerObj && playerObj.Next) {
                  playerObj.Next();
                  clicked = true;
                  console.log('SimBox Bridge: Clicked Next via player API');
                } else if (player.Next) {
                  player.Next();
                  clicked = true;
                  console.log('SimBox Bridge: Clicked Next via player');
                }
              } catch (e) {
                console.log('SimBox Bridge: Next click failed:', e);
              }
            } else if (actionData.buttonId === 'storyline-prev-button' || actionData.buttonText === 'Back') {
              try {
                const playerObj = player.GetPlayer ? player.GetPlayer() : player;
                if (playerObj && playerObj.Prev) {
                  playerObj.Prev();
                  clicked = true;
                  console.log('SimBox Bridge: Clicked Back via player API');
                } else if (player.Prev) {
                  player.Prev();
                  clicked = true;
                  console.log('SimBox Bridge: Clicked Back via player');
                }
              } catch (e) {
                console.log('SimBox Bridge: Back click failed:', e);
              }
            }
            
            // Method 1: Try Storyline player API
            if (!clicked) {
              try {
                const objectMethod = player.object || (player.GetPlayer && player.GetPlayer().object);
                if (objectMethod && typeof objectMethod === 'function' && actionData.buttonId) {
                  const button = objectMethod.call(player, actionData.buttonId);
                  if (button) {
                    console.log('SimBox Bridge: Found button via Storyline API:', button);
                    // Try different click methods
                    if (button.click && typeof button.click === 'function') {
                      button.click();
                      clicked = true;
                      console.log('SimBox Bridge: Clicked via button.click()');
                    } else if (button.onRelease && typeof button.onRelease === 'function') {
                      button.onRelease();
                      clicked = true;
                      console.log('SimBox Bridge: Clicked via button.onRelease()');
                    } else if (button.trigger && typeof button.trigger === 'function') {
                      button.trigger('click');
                      clicked = true;
                      console.log('SimBox Bridge: Clicked via button.trigger()');
                    }
                  }
                }
              } catch (e) {
                console.log('SimBox Bridge: Storyline API click failed:', e);
              }
            }
            
            // Method 2: Find by text content first (most reliable for visible buttons)
            if (!clicked && actionData.buttonText) {
              const allElements = document.querySelectorAll('*');
              for (let el of allElements) {
                const text = (el.textContent || el.innerText || '').trim();
                if (text === actionData.buttonText.trim() || 
                    text.includes(actionData.buttonText.trim())) {
                  // Check if it's actually clickable
                  const style = window.getComputedStyle(el);
                  if (el.onclick || 
                      el.getAttribute('onclick') ||
                      style.cursor === 'pointer' ||
                      el.tagName === 'BUTTON' ||
                      el.getAttribute('role') === 'button') {
                    targetElement = el;
                    break;
                  }
                }
              }
            }
            
            // Method 3: Find by data-object-id
            if (!clicked && actionData.buttonId && !targetElement) {
              targetElement = document.querySelector(`[data-object-id="${actionData.buttonId}"]`);
            }
            
            // Method 4: Find by ID
            if (!clicked && actionData.buttonId && !targetElement) {
              targetElement = document.getElementById(actionData.buttonId);
            }
            
            // Method 5: Find by class name or partial match
            if (!clicked && actionData.buttonId && !targetElement) {
              const elements = document.getElementsByClassName(actionData.buttonId);
              if (elements.length > 0) {
                targetElement = elements[0];
              } else {
                // Try partial class match
                const allElements = document.querySelectorAll('[class*="' + actionData.buttonId + '"]');
                if (allElements.length > 0) {
                  targetElement = allElements[0];
                }
              }
            }
            
            // Now try to click the target element
            if (targetElement && !clicked) {
              console.log('SimBox Bridge: Found element to click:', targetElement);
              
              // Try multiple click methods
              try {
                // Standard click
                targetElement.click();
                clicked = true;
                console.log('SimBox Bridge: Clicked via element.click()');
              } catch (e) {
                console.log('SimBox Bridge: element.click() failed:', e);
              }
              
              // If click() didn't work, try mouse events
              if (!clicked) {
                try {
                  const rect = targetElement.getBoundingClientRect();
                  const x = rect.left + rect.width / 2;
                  const y = rect.top + rect.height / 2;
                  
                  // Create and dispatch mouse events
                  const mouseDown = new MouseEvent('mousedown', {
                    view: window,
                    bubbles: true,
                    cancelable: true,
                    clientX: x,
                    clientY: y
                  });
                  const mouseUp = new MouseEvent('mouseup', {
                    view: window,
                    bubbles: true,
                    cancelable: true,
                    clientX: x,
                    clientY: y
                  });
                  const clickEvent = new MouseEvent('click', {
                    view: window,
                    bubbles: true,
                    cancelable: true,
                    clientX: x,
                    clientY: y
                  });
                  
                  targetElement.dispatchEvent(mouseDown);
                  targetElement.dispatchEvent(mouseUp);
                  targetElement.dispatchEvent(clickEvent);
                  clicked = true;
                  console.log('SimBox Bridge: Clicked via mouse events');
                } catch (e) {
                  console.log('SimBox Bridge: Mouse events failed:', e);
                }
              }
              
              // Try touch events (for mobile-like interaction)
              if (!clicked) {
                try {
                  const rect = targetElement.getBoundingClientRect();
                  const x = rect.left + rect.width / 2;
                  const y = rect.top + rect.height / 2;
                  
                  const touchStart = new TouchEvent('touchstart', {
                    bubbles: true,
                    cancelable: true,
                    touches: [new Touch({
                      identifier: 0,
                      target: targetElement,
                      clientX: x,
                      clientY: y
                    })]
                  });
                  const touchEnd = new TouchEvent('touchend', {
                    bubbles: true,
                    cancelable: true,
                    changedTouches: [new Touch({
                      identifier: 0,
                      target: targetElement,
                      clientX: x,
                      clientY: y
                    })]
                  });
                  
                  targetElement.dispatchEvent(touchStart);
                  targetElement.dispatchEvent(touchEnd);
                  clicked = true;
                  console.log('SimBox Bridge: Clicked via touch events');
                } catch (e) {
                  console.log('SimBox Bridge: Touch events failed:', e);
                }
              }
            }
            
            if (!clicked) {
              console.warn('SimBox Bridge: Could not click button:', actionData.buttonId, actionData.buttonText);
              console.warn('SimBox Bridge: Tried all methods but none worked');
            } else {
              console.log('SimBox Bridge: Successfully clicked button!');
            }
          }
          break;

        case 'navigate-next':
          // Navigate to next slide
          try {
            const playerObj = player.GetPlayer ? player.GetPlayer() : player;
            if (playerObj && playerObj.Next) {
              playerObj.Next();
            } else if (player.Next) {
              player.Next();
            }
          } catch (e) {
            console.log('SimBox Bridge: Next navigation failed:', e);
          }
          break;

        case 'navigate-prev':
          // Navigate to previous slide
          try {
            const playerObj = player.GetPlayer ? player.GetPlayer() : player;
            if (playerObj && playerObj.Prev) {
              playerObj.Prev();
            } else if (player.Prev) {
              player.Prev();
            }
          } catch (e) {
            console.log('SimBox Bridge: Prev navigation failed:', e);
          }
          break;

        case 'trigger-action':
          // Trigger a specific Storyline action
          if (actionData.actionId && player.ExecuteTrigger) {
            player.ExecuteTrigger(actionData.actionId);
          }
          break;

        default:
          console.log('SimBox Bridge: Unknown action', action);
      }

      debouncedScanForButtons(500);
    } catch (error) {
      console.error('SimBox Bridge: Error handling action', error);
    }
  }

  // Scan for available buttons on current slide
  function scanForButtons() {
    try {
      const player = GetPlayer();
      if (!player) {
        console.log('SimBox Bridge: Player not available yet');
        return;
      }

      const buttons = [];
      const processedElements = new Set();
      
      console.log('SimBox Bridge: Scanning for buttons...');
      
      // Method 0: Check Storyline player navigation controls directly
      try {
        const playerObj = player && player.GetPlayer ? player.GetPlayer() : player;
        if (playerObj) {
          // Storyline might have navigation buttons in player controls
          // Try to find them via player API or DOM
          const navControls = document.querySelector('#nav-controls, .cs-nav-controls, [class*="nav-control"], [class*="player-control"]');
          if (navControls) {
            // Look for Back/Next buttons in navigation controls
            const navButtons = navControls.querySelectorAll('button, [role="button"], [onclick], div, span, a');
            navButtons.forEach(btn => {
              if (processedElements.has(btn)) return;
              
              let text = (btn.textContent || btn.innerText || btn.getAttribute('aria-label') || '').trim();
              text = text.replace(/[←→]/g, '').trim();
              
              const isBack = /^back$|^previous$|^prev$/i.test(text);
              const isNext = /^next$/i.test(text);
              
              if (isBack || isNext) {
                const style = window.getComputedStyle(btn);
                const isClickable = btn.onclick ||
                                  btn.getAttribute('onclick') ||
                                  style.cursor === 'pointer' ||
                                  btn.tagName === 'BUTTON' ||
                                  btn.getAttribute('role') === 'button';
                
                if (isClickable) {
                  const finalText = isBack ? 'Back' : 'Next';
                  buttons.push({
                    id: btn.id || btn.getAttribute('data-object-id') || `nav-${finalText.toLowerCase()}-${buttons.length}`,
                    text: finalText,
                    type: 'button',
                    element: btn
                  });
                  processedElements.add(btn);
                  console.log(`SimBox Bridge: Found ${finalText} in nav controls:`, btn);
                }
              }
            });
          }
          
          // Also try to trigger navigation actions to see if they exist
          // This is just for detection, we'll add the buttons manually
          if (playerObj.Next || player.Next) {
            // Next button exists in player
            buttons.push({
              id: 'storyline-next-button',
              text: 'Next',
              type: 'button',
              isPlayerControl: true
            });
          }
          if (playerObj.Prev || player.Prev) {
            // Prev button exists in player
            buttons.push({
              id: 'storyline-prev-button',
              text: 'Back',
              type: 'button',
              isPlayerControl: true
            });
          }
        }
      } catch (e) {
        console.log('SimBox Bridge: Player nav controls check failed:', e);
      }
      
      // Method 0a: Direct search for Back/Next buttons by exact text match
      try {
        // Search for elements containing exactly "Back" or "Next"
        const allElements = document.querySelectorAll('*');
        allElements.forEach(el => {
          if (processedElements.has(el)) return;
          
          const text = (el.textContent || el.innerText || '').trim();
          const isExactBack = text === 'Back' || text === 'Previous' || text === 'Prev';
          const isExactNext = text === 'Next' || text === 'Continue';
          
          if (isExactBack || isExactNext) {
            // Check if visible and reasonably sized
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && rect.width < 5000 && rect.height < 5000) {
              // Check if clickable (be very lenient)
              const style = window.getComputedStyle(el);
              const isClickable = el.onclick ||
                                el.getAttribute('onclick') ||
                                style.cursor === 'pointer' ||
                                el.tagName === 'BUTTON' ||
                                el.tagName === 'A' ||
                                el.getAttribute('role') === 'button' ||
                                el.closest('[onclick]') ||
                                el.parentElement?.onclick ||
                                el.parentElement?.getAttribute('onclick');
              
              if (isClickable) {
                const finalText = isExactBack ? 'Back' : 'Next';
                const clickableEl = el.closest('[onclick]') || 
                                  (el.parentElement?.onclick ? el.parentElement : el) ||
                                  el;
                
                const objId = clickableEl.id || 
                             clickableEl.getAttribute('data-object-id') ||
                             el.getAttribute('data-object-id') ||
                             `nav-${finalText.toLowerCase()}-direct-${buttons.length}`;
                
                buttons.push({
                  id: objId,
                  text: finalText,
                  type: 'button',
                  element: clickableEl
                });
                processedElements.add(el);
                processedElements.add(clickableEl);
                console.log(`SimBox Bridge: Found ${finalText} button (direct match):`, clickableEl);
              }
            }
          }
        });
      } catch (e) {
        console.log('SimBox Bridge: Direct Back/Next search failed:', e);
      }
      
      // Method 0b: Specifically look for Back/Next buttons at bottom of screen (most common location)
      try {
        // Look for buttons in bottom area of the slide/content area
        const slideArea = document.querySelector('#preso, .primary-slide, [class*="slide"], [class*="content"]');
        if (slideArea) {
          // Find all clickable elements in bottom portion
          const allElements = slideArea.querySelectorAll('*');
          allElements.forEach(el => {
            if (processedElements.has(el)) return;
            
            const rect = el.getBoundingClientRect();
            const slideRect = slideArea.getBoundingClientRect();
            
            // Check if element is in bottom 20% of slide area (where nav buttons usually are)
            const isInBottomArea = rect.bottom > slideRect.bottom - (slideRect.height * 0.2);
            
            if (isInBottomArea) {
              let text = (el.textContent || el.innerText || el.getAttribute('aria-label') || '').trim();
              
              // Check for Back/Next specifically
              const isBack = /back|previous|prev/i.test(text) || 
                           el.classList.toString().toLowerCase().includes('back') ||
                           el.classList.toString().toLowerCase().includes('prev');
              const isNext = /next|continue/i.test(text) ||
                           el.classList.toString().toLowerCase().includes('next');
              
              if (isBack || isNext) {
                // Clean text
                if (isBack) text = 'Back';
                else if (isNext) text = 'Next';
                else {
                  text = text.replace(/[←→]/g, '').trim();
                }
                
                // Check if clickable
                const style = window.getComputedStyle(el);
                const isClickable = el.onclick ||
                                  el.getAttribute('onclick') ||
                                  style.cursor === 'pointer' ||
                                  el.tagName === 'BUTTON' ||
                                  el.getAttribute('role') === 'button' ||
                                  el.closest('[onclick]') ||
                                  el.parentElement?.onclick;
                
                if (isClickable && text) {
                  const objId = el.id || 
                               el.getAttribute('data-object-id') ||
                               el.closest('[data-object-id]')?.getAttribute('data-object-id') ||
                               `nav-${text.toLowerCase()}-${buttons.length}`;
                  
                  buttons.push({
                    id: objId,
                    text: text,
                    type: 'button',
                    element: el.closest('[onclick]') || el
                  });
                  processedElements.add(el);
                  if (el.closest('[onclick]')) {
                    processedElements.add(el.closest('[onclick]'));
                  }
                }
              }
            }
          });
        }
      } catch (e) {
        console.log('SimBox Bridge: Bottom area scan failed:', e);
      }
      
      // Method 1: Use Storyline Player API to get slide objects
      try {
        const playerObj = player && player.GetPlayer ? player.GetPlayer() : player;
        if (playerObj) {
          
          // Try to enumerate all objects using player.object() method
          // Storyline objects are typically accessed by ID
          // We'll try common object IDs and also look for objects in the DOM
          
          // Try to get objects from the current slide
          // Storyline stores objects in various ways - try different approaches
          const objectMethod = player.object || (playerObj && playerObj.object);
          if (objectMethod && typeof objectMethod === 'function') {
            // Try to find objects by looking for data-object-id attributes
            const objectIds = new Set();
            document.querySelectorAll('[data-object-id]').forEach(el => {
              const objId = el.getAttribute('data-object-id');
              if (objId) objectIds.add(objId);
            });
            
            // Also look for objects in Storyline's internal structure
            if (playerObj.slideObjects || playerObj.currentSlide) {
              const slideData = playerObj.currentSlide || playerObj.slideObjects;
              if (slideData && slideData.objects) {
                Object.keys(slideData.objects).forEach(objId => {
                  objectIds.add(objId);
                });
              }
            }
            
            // Try to get each object and check if it's a button
            objectIds.forEach(objId => {
              try {
                const obj = objectMethod.call(player || playerObj, objId);
                if (obj) {
                  // Check if it's interactive/clickable
                  const isButton = obj.kind === 'button' || 
                                 obj.onRelease || 
                                 obj.onClick ||
                                 (obj.events && obj.events.some(e => e.kind === 'onrelease' || e.kind === 'onclick'));
                  
                  if (isButton) {
                    let text = (obj.textdata && obj.textdata.text) || 
                               (obj.text && obj.text) ||
                               obj.getAttribute?.('aria-label') ||
                               objId;
                    
                    // Check if this is a navigation button by ID or text
                    const objIdLower = String(objId).toLowerCase();
                    const textLower = String(text).toLowerCase();
                    if (objIdLower.includes('next') || textLower.includes('next')) {
                      text = 'Next';
                    } else if (objIdLower.includes('back') || objIdLower.includes('prev') || 
                               textLower.includes('back') || textLower.includes('previous') || textLower.includes('prev')) {
                      text = 'Back';
                    }
                    
                    buttons.push({
                      id: objId,
                      text: String(text).substring(0, 50) || 'Button',
                      type: 'button',
                      storylineObject: obj
                    });
                  }
                }
              } catch (e) {
                // Object might not exist or not accessible
              }
            });
            
            // Also look for accessibility shadow buttons that represent Storyline objects
            document.querySelectorAll('.acc-button, [class*="acc-button"], [data-represents], button[data-represents]').forEach(accBtn => {
              if (processedElements.has(accBtn)) return;
              
              const represents = accBtn.getAttribute('data-represents');
              let text = accBtn.textContent || 
                        accBtn.getAttribute('aria-label') || 
                        accBtn.innerText || 
                        '';
              
              // Skip image filenames
              if (text.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i)) {
                // Check if it's a menu button (hamburger icon)
                const isMenu = accBtn.classList.contains('menu') ||
                              accBtn.getAttribute('aria-label')?.toLowerCase().includes('menu') ||
                              (represents && represents.toLowerCase().includes('menu'));
                if (isMenu) {
                  text = 'Menu';
                } else {
                  return; // Skip image filename buttons
                }
              }
              
              // Check if this represents a navigation button
              if (represents) {
                const repLower = represents.toLowerCase();
                let buttonText = text.trim();
                
                // Check represents attribute for navigation keywords
                if (repLower.includes('next') || repLower.includes('nav') && repLower.includes('next')) {
                  buttonText = 'Next';
                } else if (repLower.includes('back') || repLower.includes('prev') ||
                          (repLower.includes('nav') && (repLower.includes('back') || repLower.includes('prev')))) {
                  buttonText = 'Back';
                } else if (text.toLowerCase().includes('next')) {
                  buttonText = 'Next';
                } else if (text.toLowerCase().includes('back') || text.toLowerCase().includes('previous') || text.toLowerCase().includes('prev')) {
                  buttonText = 'Back';
                } else if (!buttonText || buttonText === 'Button' || buttonText.length === 0) {
                  // Try to get text from the represented object
                  try {
                    if (objectMethod && typeof objectMethod === 'function') {
                      const obj = objectMethod.call(player || playerObj, represents);
                      if (obj) {
                        if (obj.textdata && obj.textdata.text) {
                          buttonText = obj.textdata.text;
                        } else if (obj.text) {
                          buttonText = obj.text;
                        }
                        // Check object kind or properties
                        if (obj.kind === 'button') {
                          // Check object ID for navigation
                          if (repLower.includes('next')) buttonText = 'Next';
                          else if (repLower.includes('back') || repLower.includes('prev')) buttonText = 'Back';
                        }
                      }
                    }
                  } catch (e) {
                    // Ignore
                  }
                  
                  // If still no text and it's a menu-looking button, label it Menu
                  if ((!buttonText || buttonText === 'Button') && 
                      (accBtn.classList.contains('menu') || 
                       accBtn.getAttribute('aria-label')?.toLowerCase().includes('menu'))) {
                    buttonText = 'Menu';
                  }
                }
              
                if (buttonText && buttonText.trim() && !buttonText.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i)) {
                  buttons.push({
                    id: accBtn.id || represents,
                    text: buttonText.trim().substring(0, 50),
                    type: buttonText === 'Menu' ? 'menu' : 'button',
                    element: accBtn
                  });
                  processedElements.add(accBtn);
                  if (buttonText === 'Back' || buttonText === 'Next') {
                    console.log(`SimBox Bridge: Found ${buttonText} via data-represents:`, represents, accBtn);
                  }
                }
              } else if (text && text.trim() && !text.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i)) {
                // Button without data-represents but has text
                buttons.push({
                  id: accBtn.id || `acc-${buttons.length}`,
                  text: text.trim().substring(0, 50),
                  type: 'button',
                  element: accBtn
                });
                processedElements.add(accBtn);
              }
            });
          }
          
          // Also check for navigation buttons specifically - look everywhere
          try {
            // Storyline navigation buttons might be accessible via player controls
            const navControls = document.querySelector('#nav-controls, .cs-nav-controls, [class*="nav-control"], [class*="navigation"], [class*="nav-button"], [class*="next-button"], [class*="back-button"]');
            if (navControls) {
              const navButtons = navControls.querySelectorAll('button, [role="button"], [onclick], [class*="button"], div[onclick], span[onclick], a[onclick]');
              navButtons.forEach(btn => {
                let text = btn.textContent || btn.getAttribute('aria-label') || btn.innerText || btn.getAttribute('data-acc-text') || '';
                text = text.trim().replace(/[←→]/g, '').trim();
                
                // Normalize Back/Next text
                if (/back|previous|prev/i.test(text)) text = 'Back';
                else if (/next|continue/i.test(text)) text = 'Next';
                
                if (text && (text === 'Back' || text === 'Next' || text.length < 30)) {
                  buttons.push({
                    id: btn.id || btn.getAttribute('data-object-id') || `nav-${text.toLowerCase()}-${buttons.length}`,
                    text: text,
                    type: 'button',
                    element: btn
                  });
                  processedElements.add(btn);
                }
              });
            }
            
            // Also search entire document for Back/Next buttons (they might be anywhere)
            // But limit to visible, reasonably sized elements to avoid performance issues
            const allBackNext = document.querySelectorAll('div, button, span, a, [role="button"]');
            allBackNext.forEach(el => {
              if (processedElements.has(el)) return;
              
              const rect = el.getBoundingClientRect();
              // Only check visible elements with reasonable size
              if (rect.width === 0 || rect.height === 0 || rect.width > 5000 || rect.height > 5000) return;
              
              let text = (el.textContent || el.innerText || el.getAttribute('aria-label') || el.getAttribute('data-acc-text') || '').trim();
              const originalText = text;
              text = text.replace(/[←→]/g, '').trim();
              
              // More specific matching for Back/Next
              const isBack = /^(back|previous|prev)$/i.test(text) || 
                            (text.toLowerCase() === 'back' || text.toLowerCase() === 'previous' || text.toLowerCase() === 'prev');
              const isNext = /^(next|continue)$/i.test(text) ||
                            (text.toLowerCase() === 'next');
              
              // Also check if text contains Back/Next with minimal other content
              const hasBackWord = /\bback\b|\bprevious\b|\bprev\b/i.test(originalText);
              const hasNextWord = /\bnext\b|\bcontinue\b/i.test(originalText);
              
              if ((isBack || hasBackWord) || (isNext || hasNextWord)) {
                // Check if it's actually clickable - be more lenient
                const style = window.getComputedStyle(el);
                const isClickable = el.onclick ||
                                  el.getAttribute('onclick') ||
                                  style.cursor === 'pointer' ||
                                  el.tagName === 'BUTTON' ||
                                  el.tagName === 'A' ||
                                  el.getAttribute('role') === 'button' ||
                                  el.closest('[onclick]') ||
                                  (el.parentElement && (
                                    el.parentElement.onclick || 
                                    el.parentElement.getAttribute('onclick') ||
                                    window.getComputedStyle(el.parentElement).cursor === 'pointer'
                                  ));
                
                if (isClickable) {
                  const finalText = (isBack || hasBackWord) ? 'Back' : 'Next';
                  let clickableEl = el;
                  
                  // Find the actual clickable element
                  if (el.closest('[onclick]')) {
                    clickableEl = el.closest('[onclick]');
                  } else if (el.parentElement && (el.parentElement.onclick || el.parentElement.getAttribute('onclick'))) {
                    clickableEl = el.parentElement;
                  }
                  
                  const objId = clickableEl.id || 
                               clickableEl.getAttribute('data-object-id') ||
                               el.getAttribute('data-object-id') ||
                               `nav-${finalText.toLowerCase()}-${Date.now()}-${buttons.length}`;
                  
                  buttons.push({
                    id: objId,
                    text: finalText,
                    type: 'button',
                    element: clickableEl
                  });
                  processedElements.add(el);
                  processedElements.add(clickableEl);
                  console.log(`SimBox Bridge: Found ${finalText} button:`, clickableEl, originalText);
                }
              }
            });
            
            // Also look for Back/Next buttons anywhere in the document (more aggressively)
            const backNextSelectors = [
              '*[class*="back"]',
              '*[class*="next"]',
              '*[class*="prev"]',
              '*[aria-label*="back" i]',
              '*[aria-label*="next" i]',
              '*[aria-label*="previous" i]',
              '*[title*="back" i]',
              '*[title*="next" i]'
            ];
            
            backNextSelectors.forEach(selector => {
              try {
                document.querySelectorAll(selector).forEach(el => {
                  if (processedElements.has(el)) return;
                  
                  const text = (el.textContent || el.innerText || el.getAttribute('aria-label') || '').trim();
                  const isNavText = /^(back|next|previous|prev)$/i.test(text);
                  
                  if (isNavText || 
                      (text.toLowerCase().includes('back') || text.toLowerCase().includes('next')) &&
                      (el.onclick || el.getAttribute('onclick') || window.getComputedStyle(el).cursor === 'pointer')) {
                    buttons.push({
                      id: el.id || el.getAttribute('data-object-id') || `nav-${text.toLowerCase().replace(/\s+/g, '-')}-${buttons.length}`,
                      text: text || (text.toLowerCase().includes('back') ? 'Back' : 'Next'),
                      type: 'button',
                      element: el
                    });
                    processedElements.add(el);
                  }
                });
              } catch (e) {
                // Ignore selector errors
              }
            });
            
            // Also search by text content more broadly - look for Back/Next specifically
            const allClickable = document.querySelectorAll('[onclick], button, [role="button"], [class*="button"], [class*="nav"], div[onclick], span[onclick]');
            allClickable.forEach(el => {
              if (processedElements.has(el)) return;
              
              let text = (el.textContent || el.innerText || el.getAttribute('aria-label') || '').trim();
              
              // Check for Back/Next even if text has arrows or extra content
              const hasBack = /back|previous|prev/i.test(text) || 
                            el.classList.toString().toLowerCase().includes('back') ||
                            el.classList.toString().toLowerCase().includes('prev');
              const hasNext = /next|continue/i.test(text) || 
                            el.classList.toString().toLowerCase().includes('next');
              
              if (hasBack || hasNext) {
                // Extract clean text
                if (hasBack && !text.toLowerCase().includes('back') && !text.toLowerCase().includes('prev')) {
                  text = 'Back';
                } else if (hasNext && !text.toLowerCase().includes('next')) {
                  text = 'Next';
                } else {
                  // Clean up text - remove arrows, keep main word
                  text = text.replace(/[←→]/g, '').trim();
                  if (hasBack) text = 'Back';
                  else if (hasNext) text = 'Next';
                }
                
                if (text && text.length < 20) {
                  buttons.push({
                    id: el.id || el.getAttribute('data-object-id') || `nav-${text.toLowerCase()}-${buttons.length}`,
                    text: text,
                    type: 'button',
                    element: el
                  });
                  processedElements.add(el);
                }
              }
            });
          } catch (e) {
            console.log('SimBox Bridge: Nav controls scan failed:', e);
          }
        }
      } catch (e) {
        console.log('SimBox Bridge: Storyline API method failed:', e);
      }
      
      // Method 2: Find elements with Storyline-specific classes and data attributes
      try {
        // Storyline uses specific class prefixes like 'cs-'
        const storylineSelectors = [
          '[class*="cs-button"]',
          '[class*="cs-nav"]',
          '[data-object-id]',
          '[data-storyline-object]',
          '.cs-button',
          '.cs-nav-button',
          '[class*="button"][class*="cs-"]'
        ];
        
        storylineSelectors.forEach(selector => {
          try {
            const elements = document.querySelectorAll(selector);
            elements.forEach((element) => {
              if (processedElements.has(element)) return;
              processedElements.add(element);
              
              const objId = element.getAttribute('data-object-id') || 
                           element.id || 
                           `storyline-${buttons.length}`;
              let text = element.textContent || 
                        element.innerText ||
                        element.getAttribute('aria-label') ||
                        element.getAttribute('data-acc-text') ||
                        element.getAttribute('title') ||
                        element.getAttribute('data-label') ||
                        '';
              
              // Skip if text looks like an image filename
              if (text.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i)) {
                // Try to get better text from parent
                const parent = element.parentElement;
                if (parent) {
                  const parentText = parent.textContent || parent.getAttribute('aria-label') || parent.getAttribute('data-acc-text');
                  if (parentText && !parentText.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i)) {
                    text = parentText;
                  } else {
                    text = ''; // Skip this element
                  }
                } else {
                  text = ''; // Skip this element
                }
              }
              
              // Check if clickable
              const style = window.getComputedStyle(element);
              const isClickable = element.onclick ||
                                element.getAttribute('onclick') ||
                                style.cursor === 'pointer' ||
                                element.getAttribute('role') === 'button' ||
                                element.classList.contains('button') ||
                                element.classList.contains('clickable');
              
              // Check if this is a menu icon (hamburger menu)
              if ((!text || text.trim().length === 0) && isClickable) {
                // Check for hamburger menu patterns
                const hasMenuIcon = element.querySelector('svg path[d*="M3"], svg path[d*="m3"]') || // SVG hamburger
                                  element.classList.contains('menu') ||
                                  element.classList.contains('hamburger') ||
                                  element.getAttribute('aria-label')?.toLowerCase().includes('menu') ||
                                  (element.parentElement && (
                                    element.parentElement.classList.contains('menu') ||
                                    element.parentElement.getAttribute('aria-label')?.toLowerCase().includes('menu')
                                  ));
                
                if (hasMenuIcon) {
                  text = 'Menu';
                }
              }
              
              // Only add if it has meaningful text or is clearly a button element
              text = (text || '').trim().replace(/\s+/g, ' ');
              if (isClickable && (text.length > 0 || element.tagName === 'BUTTON' || element.getAttribute('data-object-id'))) {
                buttons.push({
                  id: objId,
                  text: text.substring(0, 50) || (element.tagName === 'BUTTON' ? 'Button' : ''),
                  type: text === 'Menu' ? 'menu' : 'button',
                  element: element
                });
              }
            });
          } catch (e) {
            // Ignore selector errors
          }
        });
      } catch (e) {
        console.log('SimBox Bridge: Storyline selector scan failed:', e);
      }
      
      // Method 2b: Find SVG elements (Storyline often uses SVG for buttons)
      try {
        const svgElements = document.querySelectorAll('svg, svg *');
        svgElements.forEach((element) => {
          if (processedElements.has(element)) return;
          
          // Check if it's clickable
          const style = window.getComputedStyle(element);
          const isClickable = element.onclick || 
                            element.getAttribute('onclick') ||
                            style.cursor === 'pointer' ||
                            element.getAttribute('role') === 'button' ||
                            element.classList.contains('clickable') ||
                            element.classList.contains('button');
          
          if (isClickable) {
            const text = element.textContent || 
                        element.getAttribute('aria-label') || 
                        element.getAttribute('title') ||
                        element.getAttribute('data-label') ||
                        '';
            
            // Also check parent for text
            const parentText = element.parentElement ? 
                              (element.parentElement.textContent || element.parentElement.getAttribute('aria-label') || '') : '';
            
            // Skip if text looks like an image filename
            if (text.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i)) {
              // Use parent text if available
              if (parentText && !parentText.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i)) {
                text = parentText;
              } else {
                return; // Skip this element
              }
            }
            
            const finalText = (text || '').trim() || (parentText || '').trim();
            
            if (finalText || element.tagName === 'button') {
              const objId = element.id || 
                           element.getAttribute('data-object-id') ||
                           element.parentElement?.getAttribute('data-object-id') ||
                           `svg-${buttons.length}`;
              
              buttons.push({
                id: objId,
                text: finalText.substring(0, 50) || 'Button',
                type: 'button',
                element: element
              });
              processedElements.add(element);
            }
          }
        });
      } catch (e) {
        console.log('SimBox Bridge: SVG scan failed:', e);
      }
      
      // Method 3: Find clickable elements in the DOM
      const clickableSelectors = [
        '[data-object-id]',
        '.cs-button',
        '.button',
        '[role="button"]',
        'button',
        '[onclick]',
        '[class*="button"]',
        '[class*="clickable"]',
        '[class*="interactive"]',
        'canvas[data-object-id]',
        'div[data-object-id]',
        'span[data-object-id]'
      ];

      clickableSelectors.forEach(selector => {
        try {
          const elements = document.querySelectorAll(selector);
          elements.forEach((element) => {
            if (processedElements.has(element)) return;
            processedElements.add(element);

            const objectId = element.getAttribute('data-object-id') || 
                            element.id || 
                            element.className ||
                            `element-${buttons.length}`;
            const text = element.textContent || 
                        element.innerText || 
                        element.getAttribute('aria-label') || 
                        element.title || 
                        element.getAttribute('data-label') ||
                        '';
            
            // Check if it's actually clickable
            const style = window.getComputedStyle(element);
            const isClickable = element.onclick || 
                              element.getAttribute('onclick') ||
                              style.cursor === 'pointer' || 
                              element.classList.contains('button') || 
                              element.tagName === 'BUTTON' ||
                              element.getAttribute('role') === 'button' ||
                              (style.cursor && style.cursor.includes('pointer'));

            if (isClickable && (text.trim() || element.tagName === 'BUTTON' || element.getAttribute('data-object-id'))) {
              buttons.push({
                id: objectId,
                text: text.trim().substring(0, 50) || 'Button',
                type: 'button',
                element: element
              });
            }
          });
        } catch (e) {
          // Ignore selector errors
        }
      });

      // Method 4: Look for canvas elements and their clickable overlays
      try {
        const canvasElements = document.querySelectorAll('canvas');
        canvasElements.forEach((canvas) => {
          if (processedElements.has(canvas)) return;
          
          // Storyline may use canvas with overlay divs for buttons
          const parent = canvas.parentElement;
          if (parent) {
            // Look for clickable siblings or children
            const clickableOverlay = parent.querySelector('[onclick], [data-object-id], button, [role="button"]');
            if (clickableOverlay) {
              const objId = clickableOverlay.getAttribute('data-object-id') || 
                          clickableOverlay.id || 
                          `canvas-overlay-${buttons.length}`;
              const text = clickableOverlay.textContent ||
                          clickableOverlay.getAttribute('aria-label') ||
                          clickableOverlay.title ||
                          'Canvas Button';
              
              buttons.push({
                id: objId,
                text: text.trim().substring(0, 50),
                type: 'button',
                element: clickableOverlay
              });
              processedElements.add(canvas);
              processedElements.add(clickableOverlay);
            } else if (parent.onclick || parent.getAttribute('data-object-id')) {
              const objId = parent.getAttribute('data-object-id') || 
                          parent.id || 
                          `canvas-${buttons.length}`;
              const text = parent.getAttribute('aria-label') || 
                          parent.title || 
                          'Canvas Button';
              
              buttons.push({
                id: objId,
                text: text.substring(0, 50),
                type: 'button',
                element: parent
              });
              processedElements.add(canvas);
              processedElements.add(parent);
            }
          }
        });
      } catch (e) {
        console.log('SimBox Bridge: Canvas scan failed:', e);
      }
      
      // Method 4b: Look for divs that might be button overlays (common in Storyline)
      try {
        const allDivs = document.querySelectorAll('div[data-object-id], div[onclick]');
        allDivs.forEach((div) => {
          if (processedElements.has(div)) return;
          
          const style = window.getComputedStyle(div);
          const isVisible = style.display !== 'none' && style.visibility !== 'hidden';
          const isClickable = div.onclick || 
                            div.getAttribute('onclick') ||
                            style.cursor === 'pointer' ||
                            div.getAttribute('role') === 'button';
          
          if (isVisible && isClickable) {
            const objId = div.getAttribute('data-object-id') || 
                        div.id || 
                        `div-button-${buttons.length}`;
            const text = div.textContent ||
                        div.getAttribute('aria-label') ||
                        div.title ||
                        '';
            
            if (text.trim() || div.getAttribute('data-object-id')) {
              buttons.push({
                id: objId,
                text: text.trim().substring(0, 50) || 'Button',
                type: 'button',
                element: div
              });
              processedElements.add(div);
            }
          }
        });
      } catch (e) {
        console.log('SimBox Bridge: Div overlay scan failed:', e);
      }
      
      // Method 5: Look for elements with click handlers (broader search)
      try {
        const allElements = document.querySelectorAll('*');
        allElements.forEach((element) => {
          if (processedElements.has(element)) return;
          if (element.tagName === 'SCRIPT' || element.tagName === 'STYLE') return;
          
          const hasClickHandler = element.onclick || 
                                 element.getAttribute('onclick') ||
                                 (element.addEventListener && element._listeners);
          
          if (hasClickHandler) {
            let text = element.textContent || 
                      element.innerText || 
                      element.getAttribute('aria-label') || 
                      element.title ||
                      '';
            
            // Skip if text looks like an image filename
            if (text.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i)) {
              return; // Skip this element
            }
            
            // Only add if it has meaningful text or is clearly a button
            text = (text || '').trim().replace(/\s+/g, ' ');
            
            // Filter out long text (scenario descriptions, etc.)
            if (text.length > 50) return;
            if (text.split(' ').length > 8) return; // More than 8 words is likely content, not a button
            // Filter out text that looks like content/descriptions
            if (text.match(/\b(is|are|was|were|the|a|an|to|of|in|on|at|for|with|from)\b/i) && text.split(' ').length > 4) return;
            
            if (text.length > 0) {
              const objId = element.id || 
                           element.getAttribute('data-object-id') ||
                           element.className ||
                           `clickable-${buttons.length}`;
              
              // Avoid duplicates
              if (!buttons.find(b => (b.text || '').trim() === text)) {
                buttons.push({
                  id: objId,
                  text: text.substring(0, 50),
                  type: 'button',
                  element: element
                });
                processedElements.add(element);
              }
            }
          }
        });
      } catch (e) {
        console.log('SimBox Bridge: Broad scan failed:', e);
      }

      // Clean and filter buttons
      const cleanedButtons = [];
      const seen = new Set();
      
      buttons.forEach(button => {
        let text = (button.text || '').trim();
        const id = button.id || '';
        
        // Skip if no text or empty
        if (!text || text.length === 0) return;
        
        // Filter out image filenames and non-button text
        if (text.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i)) return; // Image filenames
        if (text.match(/^[0-9]+$/)) return; // Just numbers
        if (text.length > 50) return; // Too long (likely not a button label - scenario text, descriptions, etc.)
        if (text.match(/^data:|^blob:|^http/i)) return; // URLs/data URIs
        if (text.match(/^\d+\s*:\s*\d+$/)) return; // Time displays like "5 : 0 0" or "4 : 58"
        if (text.match(/^[A-Z]\s+Symbol$/)) return; // Symbols like "X Symbol"
        if (text.match(/^[+\-×÷]$/)) return; // Single math symbols (unless it's a clear button like expand/collapse)
        // Filter out scenario/description text (usually longer sentences)
        let wordCount = text.split(' ').length;
        if (wordCount > 8) return; // More than 8 words is likely descriptive text, not a button
        // Filter out text that looks like content (contains common sentence patterns)
        if (wordCount > 4 && text.match(/\b(is|are|was|were|the|a|an|to|of|in|on|at|for|with|from|coming|looks|sick|room|triage|female|year|old)\b/i)) {
          return; // Looks like descriptive/scenario text
        }
        
        // Handle generic "Button" text - check if it's actually a menu icon
        if (text.toLowerCase() === 'button' || text.trim().length === 0) {
          // Try to identify if this is a menu/hamburger icon
          try {
            const element = document.querySelector(`[data-object-id="${id}"], #${id}, [id="${id}"]`);
            if (element) {
              const ariaLabel = element.getAttribute('aria-label') || '';
              const represents = element.getAttribute('data-represents') || '';
              // Check if it looks like a menu icon (hamburger menu)
              const isMenuIcon = element.classList.contains('menu') ||
                               element.classList.contains('hamburger') ||
                               ariaLabel.toLowerCase().includes('menu') ||
                               represents.toLowerCase().includes('menu') ||
                               element.parentElement?.classList.contains('menu') ||
                               element.querySelector('svg path[d*="M"]') || // SVG hamburger icon
                               (element.textContent === '' && element.querySelector('svg')) || // Empty text with SVG
                               (element.classList.contains('acc-button') && 
                                (represents.includes('menu') || ariaLabel.toLowerCase().includes('menu'))) ||
                               // Check if it's in top-left corner (where menus usually are)
                               (element.getBoundingClientRect().left < 100 && element.getBoundingClientRect().top < 100);
              
              if (isMenuIcon) {
                text = 'Menu';
              } else if (!id || id.length === 0) {
                return; // Skip generic "Button" without ID
              } else {
                // Has ID but no text - try to get better label
                if (ariaLabel && !ariaLabel.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i)) {
                  text = ariaLabel;
                } else {
                  return; // Skip if we can't get good text
                }
              }
            } else if (!id || id.length === 0) {
              return; // Skip if no element found and no ID
            } else {
              // Has ID but element not found - might be a valid button, keep it
              text = 'Button';
            }
          } catch (e) {
            // If we can't check, skip generic "Button" without ID
            if (!id || id.length === 0) return;
          }
        }
        
        // Clean up text - remove extra whitespace, newlines
        text = text.replace(/\s+/g, ' ').trim();
        if (text.length === 0) return;
        
        // Additional filtering for content that's clearly not a button
        // Recalculate wordCount since text may have been modified (e.g., set to 'Menu')
        wordCount = text.split(' ').length;
        // Filter out long descriptive text (scenario descriptions, etc.)
        if (wordCount > 8) return; // More than 8 words is likely content, not a button
        // Filter out text with common sentence words that suggests it's descriptive content
        if (wordCount > 4 && text.match(/\b(is|are|was|were|the|a|an|to|of|in|on|at|for|with|from|coming|looks|sick|room|triage|female|year|old|after)\b/i)) {
          return; // Looks like descriptive/scenario text
        }
        // Filter out single symbols unless they're clearly buttons (like expand/collapse)
        if (text.length === 1 && text === '+') {
          // Check if it's an expand button (like in our minimized window)
          try {
            const element = document.querySelector(`#${id}, [id="${id}"]`);
            if (element && element.closest('#simbox-bridge-container')) {
              return; // It's our expand button, don't show it
            }
          } catch (e) {
            // Ignore
          }
        }
        if (text.length === 1 && !['←', '→'].includes(text) && (!id || id.length === 0)) {
          return; // Single character that's not a navigation arrow and has no ID
        }
        
        // Create a key for deduplication
        const key = text.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        
        cleanedButtons.push({
          id: id,
          text: text,
          type: button.type || 'button'
        });
      });
      
      // Group buttons that are in menus/navigation areas
      const groupedButtons = [];
      const menuButtons = new Map(); // menu name -> buttons
      
      cleanedButtons.forEach(button => {
        // Check if this button is in a navigation/menu area
        let isInMenu = false;
        let menuName = null;
        
        // Try to find the button element to check its parent
        try {
          const element = document.querySelector(`[data-object-id="${button.id}"], #${button.id}, [id="${button.id}"]`);
          if (element) {
            const parent = element.closest('[class*="nav"], [class*="menu"], [class*="control"], #nav-controls');
            if (parent) {
              isInMenu = true;
              // Try to get menu name from parent
              menuName = parent.getAttribute('aria-label') || 
                        parent.getAttribute('title') ||
                        parent.className.split(' ').find(c => c.includes('nav') || c.includes('menu')) ||
                        'Navigation';
            }
          }
        } catch (e) {
          // Ignore errors
        }
        
        // Check if button text suggests it's a navigation button
        const navKeywords = ['back', 'next', 'previous', 'prev', 'continue', 'finish', 'submit'];
        const isNavButton = navKeywords.some(keyword => 
          button.text.toLowerCase().includes(keyword.toLowerCase())
        );
        
        // Control buttons (restart, resume) should always be shown
        const isControlButton = ['restart', 'resume'].some(keyword =>
          button.text.toLowerCase().includes(keyword.toLowerCase())
        );
        
        // Always show navigation buttons (Back, Next) - they're important
        if (isNavButton) {
          groupedButtons.push(button);
        } else if (isControlButton) {
          // Control buttons always shown
          groupedButtons.push(button);
        } else if (isInMenu && menuName) {
          // Group into menu only if it's actually in a menu container
          if (!menuButtons.has(menuName)) {
            menuButtons.set(menuName, []);
          }
          menuButtons.get(menuName).push(button);
        } else {
          // Regular button, keep it
          groupedButtons.push(button);
        }
      });
      
      // Add menu groups as single options
      menuButtons.forEach((menuButtonList, menuName) => {
        if (menuButtonList.length > 1) {
          // Multiple buttons in menu - show menu as option
          groupedButtons.push({
            id: `menu-${menuName.toLowerCase().replace(/\s+/g, '-')}`,
            text: menuName,
            type: 'menu',
            menuButtons: menuButtonList.map(b => b.text) // Store for reference
          });
        } else {
          // Single button in menu - just show the button
          groupedButtons.push(menuButtonList[0]);
        }
      });
      
      // Final deduplication by text
      const finalButtons = [];
      const finalSeen = new Set();
      groupedButtons.forEach(button => {
        const key = button.text.toLowerCase();
        if (!finalSeen.has(key)) {
          finalSeen.add(key);
          finalButtons.push(button);
        }
      });
      
      // Sort: navigation buttons first, then others
      finalButtons.sort((a, b) => {
        const aIsNav = ['back', 'next', 'previous', 'prev', 'restart', 'resume'].some(k => 
          a.text.toLowerCase().includes(k));
        const bIsNav = ['back', 'next', 'previous', 'prev', 'restart', 'resume'].some(k => 
          b.text.toLowerCase().includes(k));
        if (aIsNav && !bIsNav) return -1;
        if (!aIsNav && bIsNav) return 1;
        return a.text.localeCompare(b.text);
      });

      console.log(`SimBox Bridge: Found ${finalButtons.length} cleaned buttons:`, finalButtons.map(b => b.text));
      sendAvailableButtons(finalButtons);
    } catch (error) {
      console.error('SimBox Bridge: Error scanning buttons', error);
    }
  }

  // Send available buttons to mobile
  function sendAvailableButtons(buttons = []) {
    if (ws && ws.readyState === WebSocket.OPEN && isConnected) {
      // Remove circular references (DOM elements, Storyline objects) before sending
      const cleanButtons = buttons.map(button => ({
        id: button.id,
        text: button.text,
        type: button.type
        // Don't include 'element' or 'storylineObject' - they have circular refs
      }));
      
      console.log(`SimBox Bridge: Sending ${cleanButtons.length} buttons to mobile`);
      ws.send(JSON.stringify({
        type: 'available-buttons',
        buttons: cleanButtons
      }));
    }
  }

  // Update status display
  function updateStatus(message, type = 'info') {
    if (connectionStatus) {
      connectionStatus.textContent = message;
      const colors = {
        'connected': '#4CAF50',
        'waiting': '#FF9800',
        'error': '#F44336',
        'info': '#2196F3'
      };
      connectionStatus.style.color = colors[type] || colors.info;
    }
  }

  // Initialize UI immediately, then wait for player for functionality
  function initUI() {
    console.log('SimBox Bridge: Initializing UI...');
    console.log('SimBox Bridge: Document ready state:', document.readyState);
    console.log('SimBox Bridge: Body exists:', !!document.body);
    console.log('SimBox Bridge: Mobile UI visible:', SHOW_MOBILE_UI);

    createUI();
    // Keep mobile pairing code, but only connect when the UI is shown
    if (SHOW_MOBILE_UI) {
      connectToServer();
    }
  }

  // Wait for Storyline player to be ready (for button scanning)
  function waitForPlayer() {
    if (typeof GetPlayer !== 'undefined') {
      // Player is ready, can now scan for buttons
      console.log('SimBox Bridge: Player ready');
    } else {
      // Check every 500ms for player
      setTimeout(waitForPlayer, 500);
    }
  }

  // Start UI immediately when DOM is ready
  function startBridge() {
    console.log('SimBox Bridge: Starting bridge...');
    console.log('SimBox Bridge: Document ready state:', document.readyState);
    console.log('SimBox Bridge: Body exists:', !!document.body);
    
    // Ensure body exists and is ready
    if (!document.body) {
      console.log('SimBox Bridge: Body not ready, waiting...');
      setTimeout(startBridge, 50);
      return;
    }
    
    initUI();
    waitForPlayer();
  }

  // Start immediately - script is loaded at end of body, so body should exist
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startBridge);
  } else {
    // DOM is already loaded, but wait a tiny bit to ensure everything is ready
    setTimeout(startBridge, 50);
  }

  // Expose API for manual control
  window.SimBoxBridge = {
    reconnect: connectToServer,
    getCode: () => connectionCode,
    isConnected: () => isConnected,
    scanButtons: scanForButtons,
    debug: () => {
      console.log('=== SimBox Bridge Debug Info ===');
      console.log('- Connected:', isConnected);
      console.log('- Code:', connectionCode);
      const player = GetPlayer();
      console.log('- Player:', player);
      if (player) {
        try {
          const playerObj = player.GetPlayer();
          console.log('- Player Object:', playerObj);
          console.log('- Player Methods:', Object.keys(playerObj || {}));
        } catch (e) {
          console.log('- Player Object Error:', e);
        }
      }
      console.log('- WebSocket:', ws ? ws.readyState : 'null');
      
      // Inspect DOM for potential buttons
      console.log('\n=== DOM Inspection ===');
      const objectIds = document.querySelectorAll('[data-object-id]');
      console.log(`- Elements with data-object-id: ${objectIds.length}`);
      objectIds.forEach((el, i) => {
        if (i < 10) { // Show first 10
          console.log(`  [${i}] ID: ${el.getAttribute('data-object-id')}, Tag: ${el.tagName}, Text: "${el.textContent?.substring(0, 30)}"`);
        }
      });
      
      const clickable = document.querySelectorAll('[onclick], button, [role="button"], [class*="button"]');
      console.log(`- Potentially clickable elements: ${clickable.length}`);
      clickable.forEach((el, i) => {
        if (i < 10) {
          console.log(`  [${i}] Tag: ${el.tagName}, Classes: ${el.className}, Text: "${el.textContent?.substring(0, 30)}"`);
        }
      });
      
      console.log('\n=== Running Button Scan ===');
      scanForButtons();
    },
    inspectElement: (selector) => {
      const el = document.querySelector(selector);
      if (el) {
        console.log('Element:', el);
        console.log('- Tag:', el.tagName);
        console.log('- ID:', el.id);
        console.log('- Classes:', el.className);
        console.log('- Data attributes:', Array.from(el.attributes).filter(a => a.name.startsWith('data-')));
        console.log('- Text:', el.textContent);
        console.log('- Computed style:', window.getComputedStyle(el));
        console.log('- Has onclick:', !!el.onclick);
        return el;
      } else {
        console.log('Element not found:', selector);
        return null;
      }
    }
  };
  
  // Listen for slide changes to rescan buttons
  // Wait for player to be fully loaded
  setTimeout(() => {
    try {
      const player = GetPlayer();
      if (player) {
        const playerObj = player.GetPlayer ? player.GetPlayer() : player;
        // Try to hook into slide change events
        if (playerObj) {
          const originalNext = playerObj.Next;
          const originalPrev = playerObj.Prev;
          
          if (originalNext && typeof originalNext === 'function') {
            playerObj.Next = function() {
              const result = originalNext.apply(this, arguments);
              debouncedScanForButtons(500);
              return result;
            };
          }
          
          if (originalPrev && typeof originalPrev === 'function') {
            playerObj.Prev = function() {
              const result = originalPrev.apply(this, arguments);
              debouncedScanForButtons(500);
              return result;
            };
          }
        }
      }
    } catch (e) {
      // This is expected if player isn't ready yet - will retry on slide changes
    }
  }, 2000);

})();



