// Inspect the shipped closed shadow root through DevTools in a separate test world.
// Nothing is exposed in the page world or added to the production extension.
export async function createOverlayAccess(context, page) {
  const session = await context.newCDPSession(page);
  const { frameTree } = await session.send('Page.getFrameTree');
  const { executionContextId } = await session.send('Page.createIsolatedWorld', {
    frameId: frameTree.frame.id, worldName: 'redline-acceptance',
  });
  const host = await session.send('Runtime.evaluate', {
    contextId: executionContextId,
    expression: "document.querySelector('[data-redline-extension]')",
  });
  const { node } = await session.send('DOM.describeNode', { objectId: host.result.objectId, depth: 1, pierce: true });
  const root = node.shadowRoots?.find(item => item.shadowRootType === 'closed');
  if (!root) throw new Error('The production overlay must use a closed shadow root.');
  const { object } = await session.send('DOM.resolveNode', { backendNodeId: root.backendNodeId, executionContextId });
  await session.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: 'function() { globalThis.__redlineTestRoot = this; }',
  });
  await session.send('Runtime.releaseObject', { objectId: host.result.objectId });
  await session.send('Runtime.releaseObject', { objectId: object.objectId });
  return {
    async evaluate(fn, arg) {
      const response = await session.send('Runtime.evaluate', {
        contextId: executionContextId,
        expression: '(' + fn.toString() + ')(' + (JSON.stringify(arg) ?? 'undefined') + ')',
        awaitPromise: true, returnByValue: true,
      });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
      return response.result.value;
    },
    async importFile(file) {
      const { result } = await session.send('Runtime.evaluate', {
        contextId: executionContextId,
        expression: "globalThis.__redlineTestRoot.querySelector('input[type=file]')",
      });
      // Mirror chooseImport(), which clears the input so the same file can be chosen twice.
      await session.send('Runtime.callFunctionOn', { objectId: result.objectId, functionDeclaration: "function() { this.value = ''; }" });
      try { await session.send('DOM.setFileInputFiles', { objectId: result.objectId, files: [file] }); }
      finally { await session.send('Runtime.releaseObject', { objectId: result.objectId }); }
    },
    dispose: () => session.detach(),
  };
}
