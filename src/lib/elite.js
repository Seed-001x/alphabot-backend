// Confirmation signal ONLY, never the entry trigger.
// The desk scores the TOKEN first; this set just adds a small confidence
// boost on a hold/buy and feeds the exit check. No labels — data only.

export const ELITE = [
  { address: '2heJbC32Tpfcb3nbUb5ER61K11FGZVfVGtVnDm6LDogF' },
  { address: 'Beqv6dzTcjV2eodo8RRXCiCcnSYrS1vkQKhfqwHXqeit' },
  { address: '4ugDhHJ8XDXAeABmrNmGffFaLbJb9BkPyiFGVSV9ocwo' },
  { address: '2yXwy5Dsa1XtEXcsrkFVRJeyuWD3qKkMN3pP3p5VTW3V' },
  { address: 'H2QSGECp13sFLJgdTsDtayX3dk18Dm6sQMSQKcew7Xzk' },
  { address: '498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ' },
  { address: 'J9WiAZKf8JnCkHFL8fLCCXdEgdoLjLRqU2EGsDjdqYga' },
  { address: '2T5NgDDidkvhJQg8AHDi74uCFwgp25pYFMRZXBaCUNBH' },
  { address: '6yVb4pxNwDfr6rovwNnBg3SyKSvDcHGD4WdFPN1JJBqm' },
  { address: '4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk' },
  { address: '4xY9T1Q7foJzJsJ6YZDSsfp9zkzeZsXnxd45SixduMmr' },
  { address: '8deJ9xeUvXSJwicYptA9mHsU2rN2pDx37KWzkDkEXhU6' },
  { address: 'AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm' },
  { address: '9CNyLECt2j8tnDhqxtjYk5HUhZ2b8Nwnyb7sfYN7vND2' },
  { address: '87rRdssFiTJKY4MGARa4G5vQ31hmR7MxSmhzeaJ5AAxJ' },
];

export function shortAddr(a) { return a ? a.slice(0, 4) + '…' + a.slice(-4) : ''; }
