fetch('api/items').then(r => r.json()).then(xs => {
  document.getElementById('items').innerHTML = xs.map(x => `<li>${x.title}</li>`).join('')
})
