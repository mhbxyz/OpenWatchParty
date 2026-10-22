/** Keep source Markdown portable; apply the deployment base only to real links. */
export default function remarkSiteLinks({ base = '' } = {}) {
  const prefix = base.replace(/\/$/, '');
  return tree => {
    const visit = node => {
      if ((node.type === 'link' || node.type === 'image') && node.url?.startsWith('/') && !node.url.startsWith('//')) {
        node.url = prefix + node.url;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
