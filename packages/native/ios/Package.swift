// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "BridgeKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "BridgeKit", targets: ["BridgeKit"]),
    ],
    targets: [
        .target(name: "BridgeKit"),
    ]
)
