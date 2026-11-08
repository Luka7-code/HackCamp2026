class SiteNavbar extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
        <nav>
            <a href="/map.html">Map<a/>
            <a href="/index.html">Scan<a/>
            <a href= "/labels.html">Print Barcodes<a/>
        <nav/>
      `;
  }
}

customElements.define("site-navbar", SiteNavbar);
