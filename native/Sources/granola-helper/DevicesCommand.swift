import HelperCore

enum DevicesCommand {
    struct Output: Encodable {
        struct Input: Encodable {
            let uid: String
            let name: String
            let isDefault: Bool
        }
        let inputs: [Input]
    }

    static func run() throws -> Output {
        let defaultID = HAL.defaultInputDevice()
        let devices = try HAL.inputDevices().compactMap(InputDevice.init)
        return Output(inputs: devices.map { Output.Input(uid: $0.uid, name: $0.name, isDefault: $0.id == defaultID) })
    }
}
