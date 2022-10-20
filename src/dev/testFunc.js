

const blah = [{ priority: 1 }, { priority: 2 }]

function rango(chumbo) {
    // const gwak = chumbo
    // gwak.push(4)
    chumbo.forEach(p => { p.priority-- })
}


rango(blah)

console.log(blah)
