const expect = require('expect');
const partitioner = require('../ring/partitioner');

describe('Default partitioner', () => {

    it('Default partitioner should return the same result for the same data', () => {
        let o = {
            code : 'ojfgqklejrg3290-234234-326kdfg',
            id: 10
        }
        let i1 = partitioner.defaultPartitioner(o);
        expect(i1).toBeTruthy();
        expect(!Number.isNaN(i1)).toBeTruthy();
    });
});

describe('Assign partitions', () => {

    it('Should assign all partitions if is the first node to join ', () => {  
        let assignedPartitions = partitioner.assignPartitions({},[]);
        expect(assignedPartitions).toBeTruthy();
        expect(assignedPartitions instanceof Array).toBeTruthy();
        expect(assignedPartitions.length).toBe(10);
    });

    it('Should rebalance partitions if is not the first node to join', () => {  
        let n1 = {
            partitions : [0,1,2,3,4,5,6,7,8,9]
        }
        let addresses = [n1];
        let assignedPartitions = partitioner.assignPartitions({},addresses);
        expect(assignedPartitions).toBeTruthy();
        expect(assignedPartitions instanceof Array).toBeTruthy();
        expect(assignedPartitions.length).toBe(5);
        expect(n1.partitions).toBeTruthy();
        expect(n1.partitions instanceof Array).toBeTruthy();
        expect(n1.partitions.length).toBe(5);
        expect(n1.partitions[0]).toBe(0);
        expect(n1.partitions[1]).toBe(1);
        expect(n1.partitions[2]).toBe(2);
        expect(n1.partitions[3]).toBe(3);
        expect(n1.partitions[4]).toBe(4);
    });
});


describe('Rebalance partitions', () => {

    it('Should rebalance partitions if a node is removed', () => {  
        let client1 = {
            id: 'asdl'
        }
        let n1 = {
            partitions : [0,1,2,3,4],
            client :  client1
        }

        let client2 = {
            id: 'asdl2'
        }
        let n2 = {
            partitions : [5,6,7,8,9],
            client :  client2
        }

        let addresses = [n1,n2];
        partitioner.rebalancePartitions(client1,addresses);
        expect(addresses).toBeTruthy();
        expect(addresses.length).toBe(1);
        expect(n2.partitions).toBeTruthy();
        expect(n2.partitions.length).toBe(10);
        
    });
});
