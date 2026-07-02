var e=e=>e!=null&&String(e).trim()!==``,t=({title:t,details:n=[],warning:r=``,confirmText:i=`continue`})=>{let a=n.filter(t=>t&&e(t.value)).map(e=>`• ${e.label}: ${e.value}`);return[t,a.length?`Review before continuing:\n${a.join(`
`)}`:``,r,`Select OK to ${i}.`].filter(Boolean).join(`

`)},n=e=>window.confirm(t(e));export{n as t};