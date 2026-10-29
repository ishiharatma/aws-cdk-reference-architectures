
### Monthly cost (USD), duration 15.6 ms per request
| Option | 100k | 1.0M | 5.0M | 10.0M | 50.0M | 100.0M |
|---|---:|---:|---:|---:|---:|---:|
| WF direct | 4.03 | 4.36 | 5.81 | 7.64 | 26.21 | 52.42 |
| WF + CloudFront | 4.15 | 5.56 | 11.81 | 19.64 | 86.21 | 172.42 |
| WF + CloudFront + WAF | 13.21 | 15.16 | 23.81 | 34.64 | 125.21 | 241.42 |
| HTTP API + EF | 0.15 | 1.54 | 7.71 | 15.42 | 77.10 | 154.20 |
| REST API + EF (LWA) | 0.45 | 4.50 | 22.51 | 45.02 | 225.10 | 450.20 |
| CloudFront + Function URL + EF | 0.15 | 1.45 | 7.26 | 14.52 | 72.60 | 145.20 |
| CloudFront + Function URL + EF + WAF | 9.21 | 11.05 | 19.26 | 29.52 | 111.60 | 214.20 |

### Monthly cost (USD), duration 100 ms per request
| Option | 100k | 1.0M | 5.0M | 10.0M | 50.0M | 100.0M |
|---|---:|---:|---:|---:|---:|---:|
| WF direct | 4.03 | 4.36 | 5.81 | 7.64 | 26.21 | 52.42 |
| WF + CloudFront | 4.15 | 5.56 | 11.81 | 19.64 | 86.21 | 172.42 |
| WF + CloudFront + WAF | 13.21 | 15.16 | 23.81 | 34.64 | 125.21 | 241.42 |
| HTTP API + EF | 0.18 | 1.82 | 9.12 | 18.23 | 91.17 | 182.33 |
| REST API + EF (LWA) | 0.48 | 4.78 | 23.92 | 47.83 | 239.17 | 478.33 |
| CloudFront + Function URL + EF | 0.17 | 1.73 | 8.67 | 17.33 | 86.67 | 173.33 |
| CloudFront + Function URL + EF + WAF | 9.23 | 11.33 | 20.67 | 32.33 | 125.67 | 242.33 |

### Monthly cost (USD), duration 500 ms per request
| Option | 100k | 1.0M | 5.0M | 10.0M | 50.0M | 100.0M |
|---|---:|---:|---:|---:|---:|---:|
| WF direct | 4.03 | 4.36 | 5.81 | 7.64 | 26.21 | 52.42 |
| WF + CloudFront | 4.15 | 5.56 | 11.81 | 19.64 | 86.21 | 172.42 |
| WF + CloudFront + WAF | 13.21 | 15.16 | 23.81 | 34.64 | 125.21 | 241.42 |
| HTTP API + EF | 0.32 | 3.16 | 15.78 | 31.57 | 157.83 | 315.67 |
| REST API + EF (LWA) | 0.61 | 6.12 | 30.58 | 61.17 | 305.83 | 611.67 |
| CloudFront + Function URL + EF | 0.31 | 3.07 | 15.33 | 30.67 | 153.33 | 306.67 |
| CloudFront + Function URL + EF + WAF | 9.37 | 12.67 | 27.33 | 45.67 | 192.33 | 375.67 |

### Monthly cost (USD), duration 2000 ms per request
| Option | 100k | 1.0M | 5.0M | 10.0M | 50.0M | 100.0M |
|---|---:|---:|---:|---:|---:|---:|
| WF direct | 4.03 | 4.36 | 5.81 | 7.64 | 26.21 | 52.42 |
| WF + CloudFront | 4.15 | 5.56 | 11.81 | 19.64 | 86.21 | 172.42 |
| WF + CloudFront + WAF | 13.21 | 15.16 | 23.81 | 34.64 | 125.21 | 241.42 |
| HTTP API + EF | 0.82 | 8.16 | 40.78 | 81.57 | 407.83 | 815.67 |
| REST API + EF (LWA) | 1.11 | 11.12 | 55.58 | 111.17 | 555.84 | 1,111.67 |
| CloudFront + Function URL + EF | 0.81 | 8.07 | 40.33 | 80.67 | 403.33 | 806.67 |
| CloudFront + Function URL + EF + WAF | 9.87 | 17.67 | 52.33 | 95.67 | 442.33 | 875.67 |

### Break-even: monthly requests from which Web Functions is cheaper
| Pair | 15.6 ms | 100 ms | 500 ms | 2000 ms |
|---|---:|---:|---:|---:|
| WF direct vs HTTP API + EF | 3.4M | 2.8M | 1.4M | 513k |
| WF direct vs REST API + EF (LWA) | 966k | 912k | 700k | 372k |
| WF + CloudFront + WAF vs REST API + EF (LWA) | 5.6M | 5.0M | 3.3M | 1.5M |
| WF + CloudFront vs CloudFront + Function URL + EF | never (in 1k-10B) | 23.7M | 2.7M | 617k |

chart: /tmp/claude-1000/-workspaces-aws-cdk-reference-architectures/7e6b0fac-3cf7-4fa8-bfa6-3dd37b1dc3f4/scratchpad/cost.png
