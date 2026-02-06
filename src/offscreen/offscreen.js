// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', initOffscreen);

// Listen for messages
browser.runtime.onMessage.addListener(handleMessages);

// Notify service worker that offscreen document is ready
browser.runtime.sendMessage({ type: 'offscreen-ready' });

/**
 * Initialize offscreen document
 */
function initOffscreen() {
  console.log('MarkSnip offscreen document initialized');
  console.log('🔧 Browser downloads API available:', !!browser.downloads);
  console.log('🔧 Chrome downloads API available:', !!(typeof chrome !== 'undefined' && chrome.downloads));
  TurndownService.prototype.defaultEscape = TurndownService.prototype.escape;
}

/**
 * Handle messages from service worker
 */
async function handleMessages(message, sender) {
  // Handle messages that aren't specifically targeted at offscreen
  if (!message.target || message.target !== 'offscreen') {
    if (message.type === 'article-dom-data') {
      try {
        // Process the DOM into an article
        const article = await getArticleFromDom(message.dom, defaultOptions);

        // If selection was provided, replace content
        if (message.selection) {
          article.content = message.selection;
        }

        // Send the article back to service worker
        await browser.runtime.sendMessage({
          type: 'article-result',
          requestId: message.requestId,
          article: article
        });
      } catch (error) {
        console.error('Error processing article DOM:', error);
        await browser.runtime.sendMessage({
          type: 'article-result',
          requestId: message.requestId,
          error: error.message
        });
      }
      return;
    }
    return; // Not for this context
  }

  switch (message.type) {
    case 'process-content':
      await processContent(message);
      break;
    case 'download-markdown':
      await downloadMarkdown(
        message.markdown,
        message.title,
        message.tabId,
        message.imageList,
        message.mdClipsFolder,
        message.options
      );
      break;
    case 'process-context-menu':
      await processContextMenu(message);
      break;
    case 'copy-to-clipboard':
      await copyToClipboard(message.text);
      break;
    case 'get-article-content':
      await handleGetArticleContent(message);
      break;
    case 'cleanup-blob-url':
      // Clean up blob URL in offscreen document (has DOM access)
      try {
        URL.revokeObjectURL(message.url);
        console.log('🧹 [Offscreen] Cleaned up blob URL:', message.url);
      } catch (err) {
        console.log('⚠️ [Offscreen] Could not cleanup blob URL:', err.message);
      }
      break;
  }
}

/**
 * Process HTML content to markdown
 */
async function processContent(message) {
  try {
    const { data, requestId, tabId, options } = message;

    // Pass options to getArticleFromDom
    const article = await getArticleFromDom(data.dom, options);

    // Handle selection if provided
    if (data.selection && data.clipSelection) {
      article.content = data.selection;
    }

    // Convert to markdown using passed options
    const { markdown, imageList } = await convertArticleToMarkdown(article, null, options);

    // Format title and folder using passed options
    article.title = await formatTitle(article, options);
    const mdClipsFolder = await formatMdClipsFolder(article, options);

    // Send results back to service worker
    await browser.runtime.sendMessage({
      type: 'markdown-result',
      requestId: requestId,
      result: {
        markdown,
        article,
        imageList,
        mdClipsFolder
      }
    });
  } catch (error) {
    console.error('Error processing content:', error);
    // Notify service worker of error
    await browser.runtime.sendMessage({
      type: 'process-error',
      error: error.message
    });
  }
}

/**
 * Process context menu actions
 */
async function processContextMenu(message) {
  const { action, info, tabId, options } = message;

  try {
    if (action === 'download') {
      await handleContextMenuDownload(info, tabId, options);
    } else if (action === 'copy') {
      await handleContextMenuCopy(info, tabId, options);
    }
  } catch (error) {
    console.error(`Error processing context menu ${action}:`, error);
  }
}

/**
 * Handle context menu download action
 */
async function handleContextMenuDownload(info, tabId, providedOptions = null) {
  console.log(`Starting download for tab ${tabId}`);
  try {
    const options = providedOptions || defaultOptions;

    const article = await getArticleFromContent(tabId,
      info.menuItemId === "download-markdown-selection",
      options
    );
    if (!article?.content) {
      throw new Error(`Failed to get valid article content from tab ${tabId}`);
    }

    console.log(`Got article for tab ${tabId}, processing...`);
    const title = await formatTitle(article, options);
    const { markdown, imageList } = await convertArticleToMarkdown(article, null, options);
    const mdClipsFolder = await formatMdClipsFolder(article, options);

    console.log(`Downloading markdown for tab ${tabId}`);
    await downloadMarkdown(markdown, title, tabId, imageList, mdClipsFolder, options);

    // Signal completion
    await browser.runtime.sendMessage({
      type: 'process-complete',
      tabId: tabId,
      success: true
    });
  } catch (error) {
    console.error(`Error processing tab ${tabId}:`, error);
    await browser.runtime.sendMessage({
      type: 'process-complete',
      tabId: tabId,
      error: error.message
    });
    throw error;
  }
}

/**
 * Handle context menu copy action
 */
async function handleContextMenuCopy(info, tabId, providedOptions = null) {
  const platformOS = navigator.platform;
  const folderSeparator = platformOS.indexOf("Win") === 0 ? "\\" : "/";
  const options = providedOptions || defaultOptions;

  if (info.menuItemId === "copy-markdown-link") {
    // Don't call getOptions() - use the passed options
    const localOptions = { ...options };
    localOptions.frontmatter = localOptions.backmatter = '';
    const article = await getArticleFromContent(tabId, false, options);  // Added options
    const { markdown } = turndown(
      `<a href="${info.linkUrl}">${info.linkText || info.selectionText}</a>`,
      { ...localOptions, downloadImages: false },
      article
    );
    await copyToClipboard(markdown);
  }
  else if (info.menuItemId === "copy-markdown-image") {
    await copyToClipboard(`![](${info.srcUrl})`);
  }
  else if (info.menuItemId === "copy-markdown-obsidian") {
    const article = await getArticleFromContent(tabId, true, options);  // Added options
    const title = article.title;
    // Don't call getOptions()
    const obsidianVault = options.obsidianVault;
    const obsidianFolder = await formatObsidianFolder(article, options);
    const { markdown } = await convertArticleToMarkdown(article, false, options);

    console.log('[Offscreen] Sending markdown to service worker for Obsidian integration...');
    // Offscreen document can't access clipboard, send to service worker to handle
    await browser.runtime.sendMessage({
      type: 'obsidian-integration',
      markdown: markdown,
      tabId: tabId,
      vault: obsidianVault,
      folder: obsidianFolder,
      title: generateValidFileName(title, options.disallowedChars)
    });
  }
  else if (info.menuItemId === "copy-markdown-obsall") {
    const article = await getArticleFromContent(tabId, false, options);  // Added options
    const title = article.title;
    // Don't call getOptions()
    const obsidianVault = options.obsidianVault;
    const obsidianFolder = await formatObsidianFolder(article, options);
    const { markdown } = await convertArticleToMarkdown(article, false, options);

    console.log('[Offscreen] Sending markdown to service worker for Obsidian integration...');
    // Offscreen document can't access clipboard, send to service worker to handle
    await browser.runtime.sendMessage({
      type: 'obsidian-integration',
      markdown: markdown,
      tabId: tabId,
      vault: obsidianVault,
      folder: obsidianFolder,
      title: generateValidFileName(title, options.disallowedChars)
    });
  }
  else {
    const article = await getArticleFromContent(tabId, info.menuItemId === "copy-markdown-selection", options);  // Added options
    const { markdown } = await convertArticleToMarkdown(article, false, options);
    await copyToClipboard(markdown);
  }
}


/**
 * Copy text to clipboard
 */
async function copyToClipboard(text) {
  // Try modern Clipboard API first (but it usually fails in offscreen documents)
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      console.log('✅ [Offscreen] Successfully copied to clipboard using Clipboard API:', text.substring(0, 100) + '...');
      return true;
    } catch (clipboardError) {
      console.log('⚠️ [Offscreen] Clipboard API failed (document not focused), falling back to execCommand:', clipboardError.message);
      // Fall through to execCommand method
    }
  }

  // Fallback to execCommand method (works in offscreen documents)
  try {
    const textArea = document.getElementById('clipboard-text');
    if (!textArea) {
      console.error('❌ [Offscreen] Clipboard textarea not found');
      return false;
    }

    textArea.value = text;
    textArea.focus();
    textArea.select();

    // Try to copy using execCommand
    const success = document.execCommand('copy');

    if (success) {
      console.log('✅ [Offscreen] Successfully copied to clipboard using execCommand:', text.substring(0, 100) + '...');
      return true;
    } else {
      console.error('❌ [Offscreen] Failed to copy to clipboard using execCommand');
      return false;
    }
  } catch (error) {
    console.error('❌ [Offscreen] Error in execCommand fallback:', error);
    return false;
  }
}

/**
 * Get article content from tab
 */
async function handleGetArticleContent(message) {
  try {
    const { tabId, selection, requestId } = message;

    // Forward the request to the service worker
    await browser.runtime.sendMessage({
      type: 'forward-get-article-content',
      originalRequestId: requestId,
      tabId: tabId,
      selection: selection
    });

  } catch (error) {
    console.error('Error handling get article content:', error);
    await browser.runtime.sendMessage({
      type: 'article-error',
      requestId: message.requestId,
      error: error.message
    });
  }
}


/**
 * Get article content from tab
 */