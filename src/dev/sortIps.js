let arrayOfIps = ['1.2.3.4:16127', '1.1.1.1:12123', '1.1.1.1:65565', '2.3.4.5', '240.10.1.1']

function getLowestIp(ips) {
    let sorted = ips.sort((a, b) => {
        const num1 = Number(a.split(".").map((num) => (`000${num}`).slice(-3)).join(""));
        const num2 = Number(b.split(".").map((num) => (`000${num}`).slice(-3)).join(""));
        return num1 - num2;
    });
    return sorted[0]
}

console.log(getLowestIp(arrayOfIps))
