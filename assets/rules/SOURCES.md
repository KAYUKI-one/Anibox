# Rule resources

Bootstrap files are downloaded by `npm run setup:cores` from v2rayN's public rule provider (the SRS binaries are not stored in this source repository):

- [Repository](https://github.com/2dust/sing-box-rules)
- [geosite-cn.srs](https://raw.githubusercontent.com/2dust/sing-box-rules/rule-set-geosite/geosite-cn.srs)
- [geoip-cn.srs](https://raw.githubusercontent.com/2dust/sing-box-rules/rule-set-geoip/geoip-cn.srs)

The source bootstrap pins upstream commits and SHA256 hashes in `scripts/setup-cores.ps1`.
At runtime the application checks 30 seconds after launch, then hourly, and downloads only after 24 hours since the last successful check. It does not schedule work outside the running application.
Both resources are staged and checked with the selected sing-box binary before activating a new generation.
An existing generation stays available when a request or validation fails. Native JSON profiles are not modified.
Unchanged files only update the check timestamp. Updates do not restart a running core.
The two sets cover mainland domain/IP bypass; service-specific routing and ad blocking require additional sets. Xray DAT files are currently bundled only, without automatic updates.
