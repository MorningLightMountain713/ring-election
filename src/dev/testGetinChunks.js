const axios = require("axios")

const delay = (ms = 1000) => new Promise((r) => setTimeout(r, ms));

const getInChunk = async function (items, chunkSize) {
    let results = [];
    let chunkPromises = [];
    let chunkResults = [];
    for (let index = 0; index < items.length; index++) {
        if (index % chunkSize === 0) {
            chunkPromises = [];
            chunkResults.push(await Promise.all(chunkPromises));
        } else {
            chunkPromises.push(
                axios.get(`https://jsonplaceholder.typicode.com/todos/${items[index]}`).then(res => res.data)
            );
        }
    }
    // last chunk
    if (chunkPromises.length) {
        chunkResults.push(await Promise.all(chunkPromises));
    }
    // flatten 
    chunkResults.forEach(chunk => {
        results = results.concat(chunk)
    })
    console.log(results)
    return results;
};

async function main() {
    const strings = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const results = await getInChunk(strings, 5);
    console.log(results);
}
main();
